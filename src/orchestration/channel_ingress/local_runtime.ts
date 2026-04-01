import type { WorkerPool } from "../../agent/worker_pool.ts";
import {
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../../messaging/a2a/task_mapping.ts";
import { TaskStore } from "../../messaging/a2a/tasks.ts";
import { transitionTask } from "../../messaging/a2a/internal_contract.ts";
import type {
  A2AMessage,
  Artifact,
  Task,
  TaskState,
} from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { generateId } from "../../shared/helpers.ts";
import {
  type ChannelRoutePlan,
  createDirectChannelRoutePlan,
} from "../channel_routing/types.ts";
import type {
  ChannelIngressSubmission,
  DirectChannelIngressRoute,
} from "./types.ts";
import { requireDirectChannelIngressRouteFromPlan } from "./direct_route.ts";
import { createChannelTaskMessage } from "./task_message.ts";
import { getChannelTaskResponseText } from "./task_response.ts";

export interface LocalChannelIngressRuntimeDeps {
  workerPool: Pick<WorkerPool, "send">;
  taskStore?: TaskStore;
}

interface BroadcastExecutionResult {
  agentId: string;
  agentTaskId: string;
  state: Extract<TaskState, "COMPLETED" | "FAILED" | "REJECTED">;
  text: string;
}

export class LocalChannelIngressRuntime {
  private readonly workerPool: Pick<WorkerPool, "send">;
  private readonly taskStore: TaskStore;

  constructor(deps: LocalChannelIngressRuntimeDeps) {
    this.workerPool = deps.workerPool;
    this.taskStore = deps.taskStore ?? new TaskStore();
  }

  async submit(
    message: ChannelMessage,
    route?: ChannelRoutePlan,
  ): Promise<ChannelIngressSubmission> {
    const routePlan = resolveLocalChannelRoutePlan(message, route);
    const taskId = resolveRequestedTaskId(message) ?? generateId();
    const contextId = routePlan.contextId ?? message.sessionId;

    let task = await this.taskStore.create(
      taskId,
      createChannelTaskMessage(message),
      contextId,
    );
    task = withLocalIngressMetadata(task, message, routePlan);
    task = withLocalIngressRequestMetadata(task, message, routePlan);
    await this.taskStore.put(task);

    const completed = routePlan.delivery === "broadcast"
      ? await this.executeBroadcastTask(task, message, routePlan, contextId)
      : await this.executeDirectTask(
        task,
        requireDirectChannelIngressRouteFromPlan(message, routePlan),
        message,
        contextId,
      );
    return {
      task: completed,
      taskId: completed.id,
      contextId: completed.contextId,
    };
  }

  async getTask(taskId: string): Promise<Task | null> {
    return await this.taskStore.get(taskId);
  }

  async continueTask(
    taskId: string,
    message: ChannelMessage,
  ): Promise<Task | null> {
    const existing = await this.taskStore.get(taskId);
    if (!existing) return null;

    if (existing.status.state !== "INPUT_REQUIRED") {
      throw new DenoClawError(
        "TASK_NOT_WAITING_FOR_INPUT",
        { taskId, state: existing.status.state },
        "Only INPUT_REQUIRED tasks can be resumed through channel ingress",
      );
    }

    const targetAgent = resolveStoredTargetAgent(existing);
    const resumed = transitionTask(existing, "WORKING");
    resumed.history = [...existing.history, createChannelTaskMessage(message)];
    await this.taskStore.put(resumed);

    return await this.executeTask(
      resumed,
      targetAgent,
      message,
      undefined,
      resumed.contextId ?? message.sessionId,
    );
  }

  close(): void {
    this.taskStore.close();
  }

  private async executeTask(
    task: Task,
    targetAgent: string,
    message: ChannelMessage,
    route: DirectChannelIngressRoute | undefined,
    contextId: string,
  ): Promise<Task> {
    const working = transitionTask(task, "WORKING");
    await this.taskStore.put(working);

    try {
      const response = await this.workerPool.send(
        targetAgent,
        message.sessionId,
        message.content,
        {
          model: getIngressModelOverride(route),
          taskId: working.id,
          contextId,
        },
      );
      const completed = mapTaskResultToCompletion(working, response.content);
      completed.metadata = working.metadata;
      await this.taskStore.put(completed);
      return completed;
    } catch (error) {
      const failed = mapTaskErrorToTerminalStatus(working, error);
      failed.metadata = working.metadata;
      await this.taskStore.put(failed);
      return failed;
    }
  }

  private async executeDirectTask(
    task: Task,
    directRoute: DirectChannelIngressRoute,
    message: ChannelMessage,
    contextId: string,
  ): Promise<Task> {
    return await this.executeTask(
      task,
      directRoute.agentId,
      message,
      directRoute,
      contextId,
    );
  }

  private async executeBroadcastTask(
    task: Task,
    message: ChannelMessage,
    routePlan: ChannelRoutePlan,
    contextId: string,
  ): Promise<Task> {
    const working = transitionTask(task, "WORKING");
    await this.taskStore.put(working);

    const targetAgentIds = normalizeBroadcastTargetAgentIds(routePlan);
    const results = await Promise.all(
      targetAgentIds.map((agentId, index) =>
        this.executeBroadcastTarget(
          working,
          message,
          routePlan,
          contextId,
          agentId,
          index,
        )
      ),
    );

    const artifacts = [
      ...results.map((result) =>
        createBroadcastResultArtifact(working.id, result)
      ),
      createBroadcastSummaryArtifact(working.id, results),
    ];
    const summary = buildBroadcastSummary(results);
    const terminalState = resolveBroadcastTerminalState(results);

    const finalized = transitionTask(
      {
        ...working,
        artifacts: [...working.artifacts, ...artifacts],
      },
      terminalState,
      {
        statusMessage: createAgentTextMessage(summary),
      },
    );
    finalized.metadata = {
      ...(working.metadata ?? {}),
      broadcast: {
        delivery: "broadcast",
        targetAgentIds,
        agentTasks: results.map((result) => ({
          agentId: result.agentId,
          agentTaskId: result.agentTaskId,
          state: result.state,
        })),
      },
    };
    await this.taskStore.put(finalized);
    return finalized;
  }

  private async executeBroadcastTarget(
    task: Task,
    message: ChannelMessage,
    routePlan: ChannelRoutePlan,
    contextId: string,
    agentId: string,
    index: number,
  ): Promise<BroadcastExecutionResult> {
    const agentTaskId = `${task.id}:${index + 1}:${agentId}`;
    try {
      const response = await this.workerPool.send(
        agentId,
        message.sessionId,
        message.content,
        {
          model: getIngressModelOverride(routePlan),
          taskId: agentTaskId,
          contextId,
        },
      );
      return {
        agentId,
        agentTaskId,
        state: "COMPLETED",
        text: response.content,
      };
    } catch (error) {
      const classified = mapTaskErrorToTerminalStatus(task, error);
      return {
        agentId,
        agentTaskId,
        state: classified.status.state as Extract<
          TaskState,
          "FAILED" | "REJECTED"
        >,
        text: getChannelTaskResponseText(classified) ??
          classified.status.state,
      };
    }
  }
}

function resolveLocalChannelRoutePlan(
  message: ChannelMessage,
  route?: ChannelRoutePlan,
): ChannelRoutePlan {
  if (route) return route;
  const directRoute = requireDirectChannelIngressRouteFromPlan(message);
  return createDirectChannelRoutePlan(directRoute.agentId, {
    ...(directRoute.contextId ? { contextId: directRoute.contextId } : {}),
    ...(directRoute.metadata ? { metadata: directRoute.metadata } : {}),
  });
}

function resolveStoredTargetAgent(task: Task): string {
  const targetAgent = task.metadata?.channelIngress;
  if (
    typeof targetAgent !== "object" || targetAgent === null ||
    typeof (targetAgent as Record<string, unknown>).primaryAgentId !== "string"
  ) {
    throw new DenoClawError(
      "TASK_TARGET_UNKNOWN",
      { taskId: task.id, metadata: task.metadata },
      "Channel ingress task metadata is missing a direct primaryAgentId",
    );
  }
  return (targetAgent as { primaryAgentId: string }).primaryAgentId;
}

function withLocalIngressMetadata(
  task: Task,
  message: ChannelMessage,
  routePlan: ChannelRoutePlan,
): Task {
  return {
    ...task,
    metadata: {
      ...(task.metadata ?? {}),
      channelIngress: {
        delivery: routePlan.delivery,
        targetAgentIds: [...routePlan.targetAgentIds],
        ...(routePlan.primaryAgentId
          ? { primaryAgentId: routePlan.primaryAgentId }
          : {}),
        channelType: message.channelType,
        sessionId: message.sessionId,
        userId: message.userId,
        address: message.address,
      },
    },
  };
}

function withLocalIngressRequestMetadata(
  task: Task,
  message: ChannelMessage,
  route?: ChannelRoutePlan,
): Task {
  if (!route?.metadata && !message.metadata) {
    return task;
  }

  return {
    ...task,
    metadata: {
      ...(task.metadata ?? {}),
      request: {
        ...(route?.metadata ? { ingress: route.metadata } : {}),
        ...(message.metadata ? { channelMessage: message.metadata } : {}),
      },
    },
  };
}

function getIngressModelOverride(
  route?: { metadata?: Record<string, unknown> },
): string | undefined {
  const value = route?.metadata?.model;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function normalizeBroadcastTargetAgentIds(
  routePlan: ChannelRoutePlan,
): string[] {
  const targetAgentIds = [
    ...new Set(
      routePlan.targetAgentIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];

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

function createBroadcastResultArtifact(
  taskId: string,
  result: BroadcastExecutionResult,
): Artifact {
  return {
    artifactId: `${taskId}:${result.agentId}:result`,
    name: `${result.agentId}:${result.state.toLowerCase()}`,
    parts: [{ kind: "text", text: result.text }],
  };
}

function createBroadcastSummaryArtifact(
  taskId: string,
  results: BroadcastExecutionResult[],
): Artifact {
  return {
    artifactId: `${taskId}:broadcast-summary`,
    name: "broadcast-summary",
    parts: [{ kind: "text", text: buildBroadcastSummary(results) }],
  };
}

function buildBroadcastSummary(results: BroadcastExecutionResult[]): string {
  return results.map((result) => `[${result.agentId}] ${result.text}`).join(
    "\n\n",
  );
}

function resolveBroadcastTerminalState(
  results: BroadcastExecutionResult[],
): Extract<TaskState, "COMPLETED" | "FAILED" | "REJECTED"> {
  if (results.every((result) => result.state === "COMPLETED")) {
    return "COMPLETED";
  }
  if (results.some((result) => result.state === "COMPLETED")) {
    return "COMPLETED";
  }
  if (results.every((result) => result.state === "REJECTED")) {
    return "REJECTED";
  }
  return "FAILED";
}

function createAgentTextMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
  };
}

function resolveRequestedTaskId(message: ChannelMessage): string | undefined {
  const value = message.metadata?.taskId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
