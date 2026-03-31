import {
  assertValidTaskTransition,
  isTerminalTaskState,
  transitionTask,
} from "../../messaging/a2a/internal_contract.ts";
import {
  getAwaitedInputMetadata,
  getResumePayloadMetadata,
} from "../../messaging/a2a/input_metadata.ts";
import type { TaskStore } from "../../messaging/a2a/tasks.ts";
import type {
  A2AMessage,
  Artifact,
  Task,
  TaskState,
} from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { generateId } from "../../shared/helpers.ts";
import { getChannelTaskResponseText } from "../channel_ingress/task_response.ts";
import { createChannelTaskMessage } from "../channel_ingress/task_message.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";
import type {
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskResultPayload,
  BrokerTaskSubmitPayload,
} from "../types.ts";
import {
  extractBrokerContinuationMessage,
  extractBrokerSubmitTaskMessage,
} from "../types.ts";
import type { ApprovalGrant } from "./persistence.ts";
import type {
  BrokerAgentTaskRef,
  BrokerSharedTaskMetadata,
  BrokerTaskMetadata,
  BrokerTaskPersistence,
} from "./persistence.ts";

type BrokerTaskEnvelope = Extract<
  BrokerMessage,
  {
    type: "task_submit" | "task_continue";
  }
>;

interface BroadcastAgentTaskResult {
  agentId: string;
  agentTaskId: string;
  state: TaskState;
  text: string;
}

export interface BrokerTaskDispatcherDeps {
  taskStore: TaskStore;
  persistence: BrokerTaskPersistence;
  routeTaskMessage(
    targetAgentId: string,
    message: BrokerTaskEnvelope,
  ): Promise<void>;
}

export class BrokerTaskDispatcher {
  constructor(private readonly deps: BrokerTaskDispatcherDeps) {}

  async submitAgentTask(
    fromAgentId: string,
    payload: BrokerTaskSubmitPayload,
  ): Promise<Task> {
    await this.deps.persistence.assertPeerAccess(
      fromAgentId,
      payload.targetAgent,
    );

    return await this.submitRoutedTask({
      from: fromAgentId,
      targetAgent: payload.targetAgent,
      taskId: payload.taskId,
      contextId: payload.contextId,
      taskMessage: extractBrokerSubmitTaskMessage(payload),
      forwardedMetadata: payload.metadata,
      brokerMetadata: {
        submittedBy: fromAgentId,
        targetAgent: payload.targetAgent,
        ...(payload.metadata ? { request: payload.metadata } : {}),
      },
    });
  }

  async submitChannelTask(
    message: ChannelMessage,
    input: {
      routePlan: ChannelRoutePlan;
      taskId: string;
    },
  ): Promise<Task> {
    const submittedBy = `channel:${message.channelType}`;
    const contextId = input.routePlan.contextId ?? message.sessionId;
    const taskMessage = createChannelTaskMessage(message);
    const forwardedMetadata = createChannelForwardedMetadata(
      message,
      input.routePlan.metadata,
    );

    if (input.routePlan.delivery === "broadcast") {
      return await this.submitBroadcastChannelTask(message, {
        submittedBy,
        routePlan: input.routePlan,
        taskId: input.taskId,
        contextId,
        taskMessage,
        forwardedMetadata,
      });
    }

    const targetAgent = resolveDirectRouteTargetAgent(input.routePlan);
    return await this.submitRoutedTask({
      from: submittedBy,
      targetAgent,
      taskId: input.taskId,
      contextId,
      taskMessage,
      forwardedMetadata,
      brokerMetadata: createChannelBrokerMetadata(message, {
        submittedBy,
        delivery: "direct",
        targetAgent,
        targetAgentIds: [targetAgent],
        metadata: input.routePlan.metadata,
      }),
    });
  }

  async getTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.deps.taskStore.get(payload.taskId);
  }

  async continueAgentTask(
    fromAgentId: string,
    payload: BrokerTaskContinuePayload,
  ): Promise<Task | null> {
    const existing = await this.deps.taskStore.get(payload.taskId);
    if (!existing) return null;

    const brokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
      existing,
    );
    const targetAgentId = requireBrokerTaskTargetAgent(
      existing.id,
      brokerMetadata,
    );
    await this.deps.persistence.assertPeerAccess(fromAgentId, targetAgentId);

    if (existing.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId: existing.id, state: existing.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through broker continuation",
      );
    }

    const continuationMessage = extractBrokerContinuationMessage(payload);
    const resume = getResumePayloadMetadata({ metadata: payload.metadata });
    if (resume?.approved === false) {
      const rejected = transitionTask(existing, "REJECTED", {
        statusMessage: continuationMessage,
      });
      rejected.history = [...existing.history, continuationMessage];
      await this.deps.persistence.writeTask(rejected);
      return rejected;
    }

    let updated = existing;
    if (resume?.approved === true) {
      updated = await this.persistApprovedResumeGrant(existing, brokerMetadata);
    }

    await this.routeTaskContinuation(
      fromAgentId,
      targetAgentId,
      payload,
      continuationMessage,
    );

    return updated;
  }

  async continueChannelTask(
    message: ChannelMessage,
    payload: BrokerTaskContinuePayload,
  ): Promise<Task | null> {
    const existing = await this.deps.taskStore.get(payload.taskId);
    if (!existing) return null;

    const brokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
      existing,
    );
    this.assertChannelAccess(message, brokerMetadata);

    if (brokerMetadata.delivery === "broadcast") {
      return await this.continueSharedChannelTask(
        message,
        payload,
        existing,
        brokerMetadata,
      );
    }

    const targetAgentId = requireBrokerTaskTargetAgent(
      existing.id,
      brokerMetadata,
    );
    if (existing.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId: existing.id, state: existing.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through channel continuation",
      );
    }

    const continuationMessage = extractBrokerContinuationMessage(payload);
    const resume = getResumePayloadMetadata({ metadata: payload.metadata });
    if (resume?.approved === false) {
      const rejected = transitionTask(existing, "REJECTED", {
        statusMessage: continuationMessage,
      });
      rejected.history = [...existing.history, continuationMessage];
      await this.deps.persistence.writeTask(rejected);
      return rejected;
    }

    let updated = existing;
    if (resume?.approved === true) {
      updated = await this.persistApprovedResumeGrant(existing, brokerMetadata);
    }

    await this.routeTaskContinuation(
      `channel:${message.channelType}`,
      targetAgentId,
      payload,
      continuationMessage,
    );

    return updated;
  }

  async cancelTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.deps.taskStore.cancel(payload.taskId);
  }

  async recordTaskResult(
    fromAgentId: string,
    payload: BrokerTaskResultPayload,
  ): Promise<Task | null> {
    const incomingTask = payload.task;
    if (!incomingTask) return null;

    const existing = await this.deps.taskStore.get(incomingTask.id);
    if (!existing) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: incomingTask.id, fromAgentId },
        "Submit the task through the broker before reporting a result",
      );
    }

    const brokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
      existing,
    );
    const persisted = await this.persistReportedTask(
      existing,
      incomingTask,
      brokerMetadata,
      fromAgentId,
    );

    if (typeof brokerMetadata.sharedTaskId === "string") {
      await this.refreshSharedBroadcastTask(brokerMetadata.sharedTaskId);
    }

    return persisted;
  }

  private async submitBroadcastChannelTask(
    message: ChannelMessage,
    input: {
      submittedBy: string;
      routePlan: ChannelRoutePlan;
      taskId: string;
      contextId: string;
      taskMessage: A2AMessage;
      forwardedMetadata?: Record<string, unknown>;
    },
  ): Promise<Task> {
    const targetAgentIds = normalizeBroadcastTargetAgentIds(input.routePlan);
    const agentTaskRefs = targetAgentIds.map((agentId, index) => ({
      agentId,
      taskId: createBroadcastAgentTaskId(input.taskId, agentId, index),
      state: "SUBMITTED" as TaskState,
    }));

    const sharedTask = await this.deps.taskStore.create(
      input.taskId,
      input.taskMessage,
      input.contextId,
    );
    const sharedBrokerMetadata = createChannelBrokerMetadata(message, {
      submittedBy: input.submittedBy,
      delivery: "broadcast",
      targetAgentIds,
      metadata: input.routePlan.metadata,
      shared: { agentTasks: agentTaskRefs },
    });
    const persistedSharedTask = withSharedBroadcastTaskMetadata(
      sharedTask,
      sharedBrokerMetadata,
    );
    await this.deps.persistence.writeTask(persistedSharedTask);

    for (const agentTask of agentTaskRefs) {
      await this.submitRoutedTask({
        from: input.submittedBy,
        targetAgent: agentTask.agentId,
        taskId: agentTask.taskId,
        contextId: input.contextId,
        taskMessage: input.taskMessage,
        forwardedMetadata: input.forwardedMetadata,
        brokerMetadata: createChannelBrokerMetadata(message, {
          submittedBy: input.submittedBy,
          delivery: "direct",
          targetAgent: agentTask.agentId,
          targetAgentIds: [agentTask.agentId],
          metadata: input.routePlan.metadata,
          sharedTaskId: persistedSharedTask.id,
        }),
      });
    }

    return persistedSharedTask;
  }

  private async persistReportedTask(
    existing: Task,
    incomingTask: Task,
    brokerMetadata: BrokerTaskMetadata,
    fromAgentId: string,
  ): Promise<Task> {
    const targetAgentId = requireBrokerTaskTargetAgent(
      existing.id,
      brokerMetadata,
    );
    if (targetAgentId !== fromAgentId) {
      throw new DenoClawError(
        "TASK_RESULT_FORBIDDEN",
        { taskId: existing.id, expected: targetAgentId, actual: fromAgentId },
        `Only "${targetAgentId}" can report the result for task "${existing.id}"`,
      );
    }
    if (incomingTask.contextId !== existing.contextId) {
      throw new DenoClawError(
        "TASK_CONTEXT_MISMATCH",
        {
          taskId: existing.id,
          expected: existing.contextId,
          actual: incomingTask.contextId,
        },
        "Preserve the canonical task/context correlation ids when reporting results",
      );
    }

    if (existing.status.state !== incomingTask.status.state) {
      if (isTerminalTaskState(existing.status.state)) {
        throw new DenoClawError(
          "TASK_ALREADY_TERMINAL",
          {
            taskId: existing.id,
            existingState: existing.status.state,
            incomingState: incomingTask.status.state,
          },
          "Task is already terminal; ignore duplicate terminal updates",
        );
      }
      assertValidTaskTransition(
        existing.status.state,
        incomingTask.status.state,
      );
    }

    const persisted: Task = {
      ...incomingTask,
      metadata: {
        ...(incomingTask.metadata ?? {}),
        broker: brokerMetadata,
      },
    };

    await this.deps.persistence.writeTask(persisted);
    return persisted;
  }

  private async continueSharedChannelTask(
    message: ChannelMessage,
    payload: BrokerTaskContinuePayload,
    existing: Task,
    brokerMetadata: BrokerTaskMetadata,
  ): Promise<Task> {
    if (existing.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId: existing.id, state: existing.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through channel continuation",
      );
    }

    const pausedAgentTasks = await this.loadSharedPausedAgentTasks(
      existing.id,
      brokerMetadata,
    );
    const continuationMessage = extractBrokerContinuationMessage(payload);
    const resume = getResumePayloadMetadata({ metadata: payload.metadata });

    if (resume?.approved === false) {
      for (const pausedAgentTask of pausedAgentTasks) {
        const rejected = transitionTask(pausedAgentTask.task, "REJECTED", {
          statusMessage: continuationMessage,
        });
        rejected.history = [
          ...pausedAgentTask.task.history,
          continuationMessage,
        ];
        await this.deps.persistence.writeTask(rejected);
      }
      await this.refreshSharedBroadcastTask(existing.id);
      return await this.requireTask(existing.id);
    }

    for (const pausedAgentTask of pausedAgentTasks) {
      if (resume?.approved === true) {
        await this.persistApprovedResumeGrant(
          pausedAgentTask.task,
          pausedAgentTask.brokerMetadata,
        );
      }
      await this.routeTaskContinuation(
        `channel:${message.channelType}`,
        pausedAgentTask.targetAgentId,
        {
          ...payload,
          taskId: pausedAgentTask.task.id,
        },
        continuationMessage,
      );
    }

    return existing;
  }

  private async refreshSharedBroadcastTask(
    sharedTaskId: string,
  ): Promise<void> {
    const sharedTask = await this.deps.taskStore.get(sharedTaskId);
    if (!sharedTask) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: sharedTaskId },
        "Shared ingress task is missing from broker persistence",
      );
    }

    const sharedBrokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
      sharedTask,
    );
    const agentTaskRefs = sharedBrokerMetadata.shared?.agentTasks ?? [];
    if (agentTaskRefs.length === 0) {
      throw new DenoClawError(
        "CHANNEL_ROUTE_INVALID",
        { taskId: sharedTaskId, brokerMetadata: sharedBrokerMetadata },
        "Shared ingress task metadata is missing agent task references",
      );
    }

    const agentTasks = await Promise.all(
      agentTaskRefs.map(async (agentTaskRef) => {
        const task = await this.deps.taskStore.get(agentTaskRef.taskId);
        if (!task) {
          throw new DenoClawError(
            "TASK_NOT_FOUND",
            { taskId: agentTaskRef.taskId, sharedTaskId },
            "Broadcast agent task is missing from broker persistence",
          );
        }
        return task;
      }),
    );

    const nextAgentTaskRefs = agentTaskRefs.map((agentTaskRef, index) => ({
      ...agentTaskRef,
      state: agentTasks[index].status.state,
    }));
    const nextBrokerMetadata: BrokerTaskMetadata = {
      ...sharedBrokerMetadata,
      shared: { agentTasks: nextAgentTaskRefs },
    };
    const agentTaskResults = agentTasks.map((task, index) =>
      toBroadcastAgentTaskResult(nextAgentTaskRefs[index], task)
    );
    const baseSharedTask = withSharedBroadcastTaskMetadata(
      {
        ...sharedTask,
        artifacts: createBroadcastArtifacts(sharedTask.id, agentTaskResults),
      },
      nextBrokerMetadata,
    );

    const aggregate = resolveSharedBroadcastTaskStatus(agentTaskResults);
    const nextSharedTask = applyAggregateStatus(baseSharedTask, aggregate);
    await this.deps.persistence.writeTask(nextSharedTask);
  }

  private async submitRoutedTask(input: {
    from: string;
    targetAgent: string;
    taskId: string;
    contextId?: string;
    taskMessage: A2AMessage;
    forwardedMetadata?: Record<string, unknown>;
    brokerMetadata: BrokerTaskMetadata;
  }): Promise<Task> {
    const task = await this.deps.taskStore.create(
      input.taskId,
      input.taskMessage,
      input.contextId,
    );

    const persistedTask = await this.deps.persistence.persistTaskMetadata(
      task,
      input.brokerMetadata,
    );

    await this.deps.routeTaskMessage(input.targetAgent, {
      id: generateId(),
      from: input.from,
      to: input.targetAgent,
      type: "task_submit",
      payload: {
        targetAgent: input.targetAgent,
        taskId: persistedTask.id,
        taskMessage: input.taskMessage,
        contextId: persistedTask.contextId,
        ...(input.forwardedMetadata
          ? { metadata: input.forwardedMetadata }
          : {}),
      },
      timestamp: new Date().toISOString(),
    });

    return persistedTask;
  }

  private assertChannelAccess(
    message: ChannelMessage,
    brokerMetadata: BrokerTaskMetadata,
  ): void {
    const channel = brokerMetadata.channel;
    if (!channel) {
      throw new DenoClawError(
        "TASK_CHANNEL_CONTEXT_MISSING",
        { sessionId: message.sessionId, channelType: message.channelType },
        "Task was not created from a channel ingress context",
      );
    }
    if (channel.channelType !== message.channelType) {
      throw new DenoClawError(
        "TASK_CHANNEL_MISMATCH",
        {
          expected: channel.channelType,
          actual: message.channelType,
          taskSessionId: channel.sessionId,
          messageSessionId: message.sessionId,
        },
        "Resume the task through the same channel type that created it",
      );
    }
    if (channel.sessionId !== message.sessionId) {
      throw new DenoClawError(
        "TASK_SESSION_MISMATCH",
        {
          expected: channel.sessionId,
          actual: message.sessionId,
          channelType: message.channelType,
        },
        "Resume the task through the same channel session",
      );
    }
    if (channel.userId !== message.userId) {
      throw new DenoClawError(
        "TASK_USER_MISMATCH",
        {
          expected: channel.userId,
          actual: message.userId,
          channelType: message.channelType,
        },
        "Resume the task as the same channel user",
      );
    }
  }

  private async persistApprovedResumeGrant(
    task: Task,
    brokerMetadata: BrokerTaskMetadata,
  ): Promise<Task> {
    const awaitedInput = getAwaitedInputMetadata(task.status);
    const command = awaitedInput?.kind === "approval"
      ? awaitedInput.command
      : "*";
    const binary = awaitedInput?.kind === "approval" && awaitedInput.binary
      ? awaitedInput.binary
      : command;
    const pendingResumes = this.deps.persistence.getPendingResumes(
      brokerMetadata,
    );
    const grant: ApprovalGrant = {
      kind: "approval",
      approved: true,
      command,
      binary,
      grantedAt: new Date().toISOString(),
    };
    return await this.deps.persistence.persistTaskMetadata(task, {
      ...brokerMetadata,
      pendingResumes: { ...pendingResumes, [command]: grant },
    });
  }

  private async routeTaskContinuation(
    from: string,
    targetAgentId: string,
    payload: BrokerTaskContinuePayload,
    continuationMessage: A2AMessage,
  ): Promise<void> {
    await this.deps.routeTaskMessage(targetAgentId, {
      id: generateId(),
      from,
      to: targetAgentId,
      type: "task_continue",
      payload: { ...payload, continuationMessage },
      timestamp: new Date().toISOString(),
    });
  }

  private async loadSharedPausedAgentTasks(
    sharedTaskId: string,
    brokerMetadata: BrokerTaskMetadata,
  ): Promise<
    Array<{
      task: Task;
      brokerMetadata: BrokerTaskMetadata;
      targetAgentId: string;
    }>
  > {
    const agentTaskRefs = brokerMetadata.shared?.agentTasks ?? [];
    if (agentTaskRefs.length === 0) {
      throw new DenoClawError(
        "CHANNEL_ROUTE_INVALID",
        { taskId: sharedTaskId, brokerMetadata },
        "Shared ingress task metadata is missing agent task references",
      );
    }

    const pausedAgentTasks: Array<{
      task: Task;
      brokerMetadata: BrokerTaskMetadata;
      targetAgentId: string;
    }> = [];
    for (const agentTaskRef of agentTaskRefs) {
      const agentTask = await this.requireTask(agentTaskRef.taskId);
      if (agentTask.status.state !== "INPUT_REQUIRED") continue;
      const agentBrokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
        agentTask,
      );
      pausedAgentTasks.push({
        task: agentTask,
        brokerMetadata: agentBrokerMetadata,
        targetAgentId: requireBrokerTaskTargetAgent(
          agentTask.id,
          agentBrokerMetadata,
        ),
      });
    }

    if (pausedAgentTasks.length === 0) {
      throw new DenoClawError(
        "CHANNEL_ROUTE_INVALID",
        { taskId: sharedTaskId, brokerMetadata },
        "Shared ingress task is marked INPUT_REQUIRED but no agent task is waiting for input",
      );
    }

    return pausedAgentTasks;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.deps.taskStore.get(taskId);
    if (!task) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId },
        "Submit the task through the broker before referencing it",
      );
    }
    return task;
  }
}

function createChannelBrokerMetadata(
  message: ChannelMessage,
  input: {
    submittedBy: string;
    delivery: "direct" | "broadcast";
    targetAgent?: string;
    targetAgentIds: string[];
    metadata?: Record<string, unknown>;
    sharedTaskId?: string;
    shared?: BrokerSharedTaskMetadata;
  },
): BrokerTaskMetadata {
  return {
    submittedBy: input.submittedBy,
    delivery: input.delivery,
    ...(input.targetAgent ? { targetAgent: input.targetAgent } : {}),
    targetAgentIds: [...input.targetAgentIds],
    ...(input.sharedTaskId ? { sharedTaskId: input.sharedTaskId } : {}),
    ...(message.metadata || input.metadata
      ? {
        request: {
          ...(input.metadata ? { ingress: input.metadata } : {}),
          ...(message.metadata ? { channelMessage: message.metadata } : {}),
        },
      }
      : {}),
    channel: {
      channelType: message.channelType,
      sessionId: message.sessionId,
      userId: message.userId,
      address: message.address,
    },
    ...(input.shared ? { shared: input.shared } : {}),
  };
}

function createChannelForwardedMetadata(
  message: ChannelMessage,
  ingressMetadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ingressMetadata && !message.metadata) {
    return {
      channel: {
        channelType: message.channelType,
        sessionId: message.sessionId,
        userId: message.userId,
        address: message.address,
        timestamp: message.timestamp,
      },
    };
  }

  return {
    ...(ingressMetadata ?? {}),
    channel: {
      channelType: message.channelType,
      sessionId: message.sessionId,
      userId: message.userId,
      address: message.address,
      timestamp: message.timestamp,
    },
    ...(message.metadata ? { channelMessage: message.metadata } : {}),
  };
}

function resolveDirectRouteTargetAgent(routePlan: ChannelRoutePlan): string {
  const targetAgentIds = normalizeRouteTargetAgentIds(routePlan.targetAgentIds);
  if (routePlan.delivery !== "direct" || targetAgentIds.length !== 1) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_INVALID",
      {
        delivery: routePlan.delivery,
        targetAgentIds: routePlan.targetAgentIds,
      },
      "Direct delivery requires exactly one target agent",
    );
  }
  return targetAgentIds[0];
}

function normalizeBroadcastTargetAgentIds(
  routePlan: ChannelRoutePlan,
): string[] {
  if (routePlan.delivery !== "broadcast") {
    throw new DenoClawError(
      "CHANNEL_ROUTE_INVALID",
      {
        delivery: routePlan.delivery,
        targetAgentIds: routePlan.targetAgentIds,
      },
      "Broadcast delivery requires a broadcast route plan",
    );
  }

  const targetAgentIds = normalizeRouteTargetAgentIds(routePlan.targetAgentIds);
  if (targetAgentIds.length === 0) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_INVALID",
      {
        delivery: routePlan.delivery,
        targetAgentIds: routePlan.targetAgentIds,
      },
      "Broadcast delivery requires at least one target agent",
    );
  }
  return targetAgentIds;
}

function normalizeRouteTargetAgentIds(targetAgentIds: string[]): string[] {
  return [
    ...new Set(
      targetAgentIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function createBroadcastAgentTaskId(
  sharedTaskId: string,
  agentId: string,
  index: number,
): string {
  return `${sharedTaskId}:${index + 1}:${agentId}`;
}

function requireBrokerTaskTargetAgent(
  taskId: string,
  brokerMetadata: BrokerTaskMetadata,
): string {
  const targetAgentId = typeof brokerMetadata.targetAgent === "string"
    ? brokerMetadata.targetAgent
    : undefined;
  if (!targetAgentId) {
    throw new DenoClawError(
      "TASK_TARGET_UNKNOWN",
      { taskId, brokerMetadata },
      "Broker task metadata is missing targetAgent",
    );
  }
  return targetAgentId;
}

function withSharedBroadcastTaskMetadata(
  task: Task,
  brokerMetadata: BrokerTaskMetadata,
): Task {
  const agentTasks = brokerMetadata.shared?.agentTasks ?? [];
  return {
    ...task,
    metadata: {
      ...(task.metadata ?? {}),
      broker: brokerMetadata,
      broadcast: {
        delivery: "broadcast",
        targetAgentIds: [...(brokerMetadata.targetAgentIds ?? [])],
        agentTasks: agentTasks.map((agentTask) => ({
          agentId: agentTask.agentId,
          agentTaskId: agentTask.taskId,
          state: agentTask.state,
        })),
      },
    },
  };
}

function toBroadcastAgentTaskResult(
  agentTaskRef: BrokerAgentTaskRef,
  task: Task,
): BroadcastAgentTaskResult {
  return {
    agentId: agentTaskRef.agentId,
    agentTaskId: agentTaskRef.taskId,
    state: task.status.state,
    text: describeBroadcastAgentTask(task),
  };
}

function describeBroadcastAgentTask(task: Task): string {
  return getChannelTaskResponseText(task) ?? task.status.state;
}

function createBroadcastArtifacts(
  sharedTaskId: string,
  results: BroadcastAgentTaskResult[],
): Artifact[] {
  return [
    ...results.map((result): Artifact => ({
      artifactId: `${sharedTaskId}:${result.agentId}:result`,
      name: `${result.agentId}:${result.state.toLowerCase()}`,
      parts: [{ kind: "text", text: result.text }],
    })),
    {
      artifactId: `${sharedTaskId}:broadcast-summary`,
      name: "broadcast-summary",
      parts: [{ kind: "text", text: buildBroadcastSummary(results) }],
    } satisfies Artifact,
  ];
}

function buildBroadcastSummary(results: BroadcastAgentTaskResult[]): string {
  return results.map((result) => `[${result.agentId}] ${result.text}`).join(
    "\n\n",
  );
}

function resolveSharedBroadcastTaskStatus(
  results: BroadcastAgentTaskResult[],
): {
  state: TaskState;
  statusMessage?: A2AMessage;
} {
  if (results.every((result) => result.state === "SUBMITTED")) {
    return { state: "SUBMITTED" };
  }

  if (results.some((result) => result.state === "INPUT_REQUIRED")) {
    return {
      state: "INPUT_REQUIRED",
      statusMessage: createAgentTextMessage(buildBroadcastSummary(results)),
    };
  }

  const allTerminal = results.every((result) =>
    isTerminalTaskState(result.state)
  );
  if (allTerminal) {
    return {
      state: resolveTerminalBroadcastState(results),
      statusMessage: createAgentTextMessage(buildBroadcastSummary(results)),
    };
  }

  return {
    state: "WORKING",
    statusMessage: createAgentTextMessage(buildBroadcastSummary(results)),
  };
}

function resolveTerminalBroadcastState(
  results: BroadcastAgentTaskResult[],
): Extract<TaskState, "COMPLETED" | "FAILED" | "REJECTED"> {
  if (results.some((result) => result.state === "COMPLETED")) {
    return "COMPLETED";
  }
  if (results.every((result) => result.state === "REJECTED")) {
    return "REJECTED";
  }
  return "FAILED";
}

function applyAggregateStatus(
  task: Task,
  aggregate: { state: TaskState; statusMessage?: A2AMessage },
): Task {
  if (task.status.state === aggregate.state) {
    return {
      ...task,
      status: {
        ...task.status,
        timestamp: new Date().toISOString(),
        ...(aggregate.statusMessage
          ? { message: aggregate.statusMessage }
          : {}),
      },
    };
  }

  return transitionTask(task, aggregate.state, {
    ...(aggregate.statusMessage
      ? { statusMessage: aggregate.statusMessage }
      : {}),
  });
}

function createAgentTextMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
  };
}
