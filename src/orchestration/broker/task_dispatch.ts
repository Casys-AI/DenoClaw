import {
  assertValidTaskTransition,
  isTerminalTaskState,
  transitionTask,
} from "../../messaging/a2a/internal_contract.ts";
import {
  getAwaitedInputMetadata,
  getResumePayloadMetadata,
} from "../../messaging/a2a/input_metadata.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { generateId } from "../../shared/helpers.ts";
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
import { BrokerTaskPersistence } from "./persistence.ts";
import type { TaskStore } from "../../messaging/a2a/tasks.ts";

type BrokerTaskEnvelope = Extract<
  BrokerMessage,
  {
    type: "task_submit" | "task_continue";
  }
>;

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

    const taskMessage = extractBrokerSubmitTaskMessage(payload);
    const task = await this.deps.taskStore.create(
      payload.taskId,
      taskMessage,
      payload.contextId,
    );

    const persistedTask = await this.deps.persistence.persistTaskMetadata(
      task,
      {
        submittedBy: fromAgentId,
        targetAgent: payload.targetAgent,
        ...(payload.metadata ? { request: payload.metadata } : {}),
      },
    );

    await this.deps.routeTaskMessage(payload.targetAgent, {
      id: generateId(),
      from: fromAgentId,
      to: payload.targetAgent,
      type: "task_submit",
      payload: {
        ...payload,
        taskId: persistedTask.id,
        taskMessage,
        contextId: persistedTask.contextId,
      },
      timestamp: new Date().toISOString(),
    });

    return persistedTask;
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
      const awaitedInput = getAwaitedInputMetadata(existing.status);
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
      updated = await this.deps.persistence.persistTaskMetadata(existing, {
        ...brokerMetadata,
        pendingResumes: { ...pendingResumes, [command]: grant },
      });
    }

    await this.deps.routeTaskMessage(targetAgentId, {
      id: generateId(),
      from: fromAgentId,
      to: targetAgentId,
      type: "task_continue",
      payload: { ...payload, continuationMessage },
      timestamp: new Date().toISOString(),
    });

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
}
