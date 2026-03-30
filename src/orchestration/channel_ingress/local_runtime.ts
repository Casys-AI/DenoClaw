import type { WorkerPool } from "../../agent/worker_pool.ts";
import {
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../../messaging/a2a/task_mapping.ts";
import { TaskStore } from "../../messaging/a2a/tasks.ts";
import { transitionTask } from "../../messaging/a2a/internal_contract.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { generateId } from "../../shared/helpers.ts";
import type { ChannelIngressSubmission, ChannelRouteHint } from "./types.ts";
import { createChannelTaskMessage } from "./task_message.ts";

export interface LocalChannelIngressRuntimeDeps {
  workerPool: Pick<WorkerPool, "send">;
  taskStore?: TaskStore;
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
    route?: ChannelRouteHint,
  ): Promise<ChannelIngressSubmission> {
    const targetAgent = resolveTargetAgent(message, route);
    const taskId = generateId();
    const contextId = route?.contextId ?? message.sessionId;

    let task = await this.taskStore.create(
      taskId,
      createChannelTaskMessage(message),
      contextId,
    );
    task = withLocalIngressMetadata(task, message, targetAgent);
    task = withLocalIngressRequestMetadata(task, message, route);
    await this.taskStore.put(task);

    const completed = await this.executeTask(
      task,
      targetAgent,
      message,
      route,
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
    route: ChannelRouteHint | undefined,
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
}

function resolveTargetAgent(
  message: ChannelMessage,
  route?: ChannelRouteHint,
): string {
  const targetAgent = route?.agentId ??
    (typeof message.metadata?.agentId === "string"
      ? message.metadata.agentId
      : undefined);

  if (!targetAgent) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_MISSING",
      {
        messageId: message.id,
        channelType: message.channelType,
      },
      "Provide route.agentId or message.metadata.agentId",
    );
  }

  return targetAgent;
}

function resolveStoredTargetAgent(task: Task): string {
  const targetAgent = task.metadata?.channelIngress;
  if (
    typeof targetAgent !== "object" || targetAgent === null ||
    typeof (targetAgent as Record<string, unknown>).targetAgent !== "string"
  ) {
    throw new DenoClawError(
      "TASK_TARGET_UNKNOWN",
      { taskId: task.id, metadata: task.metadata },
      "Channel ingress task metadata is missing targetAgent",
    );
  }
  return (targetAgent as { targetAgent: string }).targetAgent;
}

function withLocalIngressMetadata(
  task: Task,
  message: ChannelMessage,
  targetAgent: string,
): Task {
  return {
    ...task,
    metadata: {
      ...(task.metadata ?? {}),
      channelIngress: {
        targetAgent,
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
  route?: ChannelRouteHint,
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
  route?: ChannelRouteHint,
): string | undefined {
  const value = route?.metadata?.model;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
