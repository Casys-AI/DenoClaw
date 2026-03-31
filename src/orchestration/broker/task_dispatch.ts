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
import { deriveAgentRuntimeCapabilitiesFromEntry } from "../../shared/runtime_capabilities.ts";
import type { Config } from "../../config/types.ts";
import type { AgentEntry } from "../../shared/types.ts";
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
import type {
  BrokerAgentTaskRef,
  BrokerSharedTaskMetadata,
  BrokerTaskMetadata,
  BrokerTaskPersistence,
} from "./persistence.ts";
import {
  arePrivilegeElevationGrantResourcesSubset,
  isPrivilegeElevationExpired,
  isPrivilegeElevationScopeWithin,
  type PrivilegeElevationGrant,
  type PrivilegeElevationGrantResource,
  type PrivilegeElevationScope,
  resolvePrivilegeElevationExpiry,
} from "../../shared/privilege_elevation.ts";

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
  config: Config;
  taskStore: TaskStore;
  persistence: BrokerTaskPersistence;
  getAgentConfigEntry(agentId: string): Promise<Deno.KvEntryMaybe<AgentEntry>>;
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

    const parentTask = payload.parentTaskId
      ? await this.resolveParentTaskForSubmission(
        fromAgentId,
        payload.parentTaskId,
      )
      : undefined;
    const parentBrokerMetadata = parentTask
      ? this.deps.persistence.getTaskBrokerMetadata(parentTask)
      : undefined;

    return await this.submitRoutedTask({
      from: fromAgentId,
      targetAgent: payload.targetAgent,
      taskId: payload.taskId,
      contextId: payload.contextId ?? parentTask?.contextId,
      taskMessage: extractBrokerSubmitTaskMessage(payload),
      forwardedMetadata: payload.metadata,
      brokerMetadata: {
        submittedBy: fromAgentId,
        targetAgent: payload.targetAgent,
        ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
        ...(parentBrokerMetadata?.channel
          ? { channel: parentBrokerMetadata.channel }
          : {}),
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
    const task = await this.deps.taskStore.get(payload.taskId);
    if (!task) return null;
    return await this.expireAwaitedInputIfNeeded(task);
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

    const activeTask = await this.expireAwaitedInputIfNeeded(existing);
    if (activeTask.status.state !== "INPUT_REQUIRED") {
      return activeTask;
    }

    if (activeTask.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId: activeTask.id, state: activeTask.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through broker continuation",
      );
    }

    const continuationMessage = extractBrokerContinuationMessage(payload);
    const resume = getResumePayloadMetadata({ metadata: payload.metadata });
    if (resume?.approved === false) {
      const rejected = transitionTask(activeTask, "REJECTED", {
        statusMessage: continuationMessage,
      });
      rejected.history = [...activeTask.history, continuationMessage];
      await this.deps.persistence.writeTask(rejected);
      return rejected;
    }

    let updated = activeTask;
    if (resume?.approved === true) {
      const awaitedInput = getAwaitedInputMetadata(activeTask.status);
      updated = awaitedInput?.kind === "privilege-elevation"
        ? await this.persistResumeGrant(activeTask, brokerMetadata, resume)
        : activeTask;
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

    const activeTask = await this.expireAwaitedInputIfNeeded(existing);
    if (activeTask.status.state !== "INPUT_REQUIRED") {
      return activeTask;
    }
    const targetAgentId = requireBrokerTaskTargetAgent(
      existing.id,
      brokerMetadata,
    );

    if (activeTask.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId: activeTask.id, state: activeTask.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through channel continuation",
      );
    }

    const continuationMessage = extractBrokerContinuationMessage(payload);
    const resume = getResumePayloadMetadata({ metadata: payload.metadata });
    if (resume?.approved === false) {
      const rejected = transitionTask(activeTask, "REJECTED", {
        statusMessage: continuationMessage,
      });
      rejected.history = [...activeTask.history, continuationMessage];
      await this.deps.persistence.writeTask(rejected);
      return rejected;
    }

    let updated = activeTask;
    if (resume?.approved === true) {
      const awaitedInput = getAwaitedInputMetadata(activeTask.status);
      updated = awaitedInput?.kind === "privilege-elevation"
        ? await this.persistResumeGrant(activeTask, brokerMetadata, resume)
        : activeTask;
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
    if (pausedAgentTasks.length === 0) {
      await this.refreshSharedBroadcastTask(existing.id);
      return await this.requireTask(existing.id);
    }
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
        const awaitedInput = getAwaitedInputMetadata(pausedAgentTask.task.status);
        if (awaitedInput?.kind === "privilege-elevation") {
          await this.persistResumeGrant(
            pausedAgentTask.task,
            pausedAgentTask.brokerMetadata,
            resume,
          );
        }
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
        const task = await this.requireTask(agentTaskRef.taskId);
        return await this.expireAwaitedInputIfNeeded(task);
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

  private async resolveParentTaskForSubmission(
    fromAgentId: string,
    parentTaskId: string,
  ): Promise<Task> {
    const parentTask = await this.deps.taskStore.get(parentTaskId);
    if (!parentTask) {
      throw new DenoClawError(
        "PARENT_TASK_NOT_FOUND",
        { parentTaskId, fromAgentId },
        "Submit the child task from an existing parent task",
      );
    }

    const parentBrokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
      parentTask,
    );
    if (parentBrokerMetadata.targetAgent !== fromAgentId) {
      throw new DenoClawError(
        "PARENT_TASK_ACCESS_DENIED",
        {
          parentTaskId,
          fromAgentId,
          parentTargetAgent: parentBrokerMetadata.targetAgent,
        },
        "Submit child tasks only from a parent task currently owned by the submitting agent",
      );
    }

    return parentTask;
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

  private async persistResumeGrant(
    existing: Task,
    brokerMetadata: BrokerTaskMetadata,
    resume: { kind?: string; grants?: unknown; scope?: unknown },
  ): Promise<Task> {
    const awaitedInput = getAwaitedInputMetadata(existing.status);
    if (
      awaitedInput?.kind === "privilege-elevation" &&
      resume.kind === "privilege-elevation"
    ) {
      if (isPrivilegeElevationExpired(awaitedInput.expiresAt)) {
        throw new DenoClawError(
          "PRIVILEGE_ELEVATION_REQUEST_EXPIRED",
          {
            taskId: existing.id,
            expiresAt: awaitedInput.expiresAt,
          },
          "Request a fresh privilege elevation; this approval window has expired",
        );
      }
      const targetAgentId = typeof brokerMetadata.targetAgent === "string"
        ? brokerMetadata.targetAgent
        : undefined;
      if (!targetAgentId) {
        throw new DenoClawError(
          "TASK_TARGET_UNKNOWN",
          { taskId: existing.id, brokerMetadata },
          "Broker task metadata is missing targetAgent",
        );
      }
      const agentConfig = await this.deps.getAgentConfigEntry(targetAgentId);
      const capabilities = deriveAgentRuntimeCapabilitiesFromEntry(
        agentConfig.value ?? undefined,
        this.deps.config.agents?.defaults?.sandbox,
        { privilegeElevationSupported: true },
      );
      if (!capabilities.sandbox.privilegeElevation.supported) {
        throw new DenoClawError(
          "PRIVILEGE_ELEVATION_DISABLED",
          { taskId: existing.id, targetAgentId },
          "Enable sandbox.privilegeElevation.enabled or widen the agent sandbox policy before resuming with privilege elevation",
        );
      }
      const scope = this.resolvePrivilegeElevationScope(
        resume.scope,
        awaitedInput.scope,
      );
      const grants = Array.isArray(resume.grants) && resume.grants.length > 0
        ? resume.grants as PrivilegeElevationGrantResource[]
        : awaitedInput.grants;
      if (
        !arePrivilegeElevationGrantResourcesSubset(grants, awaitedInput.grants)
      ) {
        throw new DenoClawError(
          "PRIVILEGE_ELEVATION_GRANT_INVALID",
          {
            requested: grants,
            allowed: awaitedInput.grants,
            taskId: existing.id,
          },
          "Resume with the requested privilege grants or a narrower subset",
        );
      }
      if (!isPrivilegeElevationScopeWithin(scope, awaitedInput.scope)) {
        throw new DenoClawError(
          "PRIVILEGE_ELEVATION_SCOPE_INVALID",
          {
            requested: scope,
            allowed: awaitedInput.scope,
            taskId: existing.id,
          },
          "Resume with the requested privilege scope or a narrower scope",
        );
      }
      const grant: PrivilegeElevationGrant = {
        kind: "privilege-elevation",
        scope,
        grants,
        grantedAt: new Date().toISOString(),
        expiresAt: scope === "session"
          ? resolvePrivilegeElevationExpiry(
            capabilities.sandbox.privilegeElevation.sessionGrantTtlSec,
          )
          : undefined,
        source: "broker-resume",
      };
      if (grant.scope === "session") {
        await this.deps.persistence.appendContextPrivilegeElevationGrant(
          targetAgentId,
          existing.contextId ?? existing.id,
          grant,
        );
        return existing;
      }
      return await this.deps.persistence.persistTaskMetadata(existing, {
        ...brokerMetadata,
        privilegeElevationGrants: [
          ...this.deps.persistence.getPrivilegeElevationGrants(brokerMetadata),
          grant,
        ],
      });
    }
    return existing;
  }

  private async expireAwaitedInputIfNeeded(task: Task): Promise<Task> {
    if (task.status.state !== "INPUT_REQUIRED") {
      return task;
    }

    const awaitedInput = getAwaitedInputMetadata(task.status);
    if (
      awaitedInput?.kind !== "privilege-elevation" ||
      !isPrivilegeElevationExpired(awaitedInput.expiresAt)
    ) {
      return task;
    }

    const expired = transitionTask(task, "FAILED", {
      statusMessage: {
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{
          kind: "text",
          text:
            "Privilege elevation request expired; request a fresh elevation to continue",
        }],
      },
      metadata: {
        errorCode: "PRIVILEGE_ELEVATION_REQUEST_EXPIRED",
        errorContext: {
          expiresAt: awaitedInput.expiresAt,
        },
      },
    });
    await this.deps.persistence.writeTask(expired);
    return expired;
  }

  private resolvePrivilegeElevationScope(
    resumeScope: unknown,
    awaitedScope: PrivilegeElevationScope,
  ): PrivilegeElevationScope {
    if (
      resumeScope === "once" || resumeScope === "task" ||
      resumeScope === "session"
    ) {
      return resumeScope;
    }
    return awaitedScope;
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
      const activeAgentTask = await this.expireAwaitedInputIfNeeded(agentTask);
      if (activeAgentTask.status.state !== "INPUT_REQUIRED") continue;
      const agentBrokerMetadata = this.deps.persistence.getTaskBrokerMetadata(
        activeAgentTask,
      );
      pausedAgentTasks.push({
        task: activeAgentTask,
        brokerMetadata: agentBrokerMetadata,
        targetAgentId: requireBrokerTaskTargetAgent(
          activeAgentTask.id,
          agentBrokerMetadata,
        ),
      });
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
