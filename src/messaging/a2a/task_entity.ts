import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import { DenoClawError } from "../../shared/errors.ts";

export const ALLOWED_TASK_STATE_TRANSITIONS: Record<
  TaskState,
  readonly TaskState[]
> = {
  SUBMITTED: ["WORKING", "CANCELED", "FAILED", "REJECTED"],
  WORKING: ["WORKING", "INPUT_REQUIRED", "COMPLETED", "FAILED", "CANCELED", "REJECTED"],
  INPUT_REQUIRED: ["WORKING", "CANCELED", "FAILED", "REJECTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELED: [],
  REJECTED: [],
};

export type RefusalTerminalReason = "user" | "policy" | "runtime" | "unknown";

export interface CanonicalTaskInit {
  id: string;
  message: A2AMessage;
  contextId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface TaskTransitionOptions {
  message?: A2AMessage;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export class TaskEntity {
  constructor(readonly task: Task) {}

  static resolveContextId(taskId: string, contextId?: string): string {
    return contextId ?? taskId;
  }

  static createCanonical(init: CanonicalTaskInit): Task {
    return {
      id: init.id,
      contextId: TaskEntity.resolveContextId(init.id, init.contextId),
      status: {
        state: "SUBMITTED",
        timestamp: init.timestamp ?? new Date().toISOString(),
      },
      artifacts: [],
      history: [init.message],
      metadata: init.metadata,
    };
  }

  static isTerminalState(state: TaskState): boolean {
    return TERMINAL_STATES.includes(state);
  }

  static canTransitionState(from: TaskState, to: TaskState): boolean {
    return ALLOWED_TASK_STATE_TRANSITIONS[from].includes(to);
  }

  static assertValidTransition(from: TaskState, to: TaskState): void {
    if (!TaskEntity.canTransitionState(from, to)) {
      throw new DenoClawError(
        "INVALID_TASK_TRANSITION",
        { from, to },
        "Check allowed state transitions in A2A contract",
      );
    }
  }

  static classifyRefusalTerminalState(
    reason: RefusalTerminalReason,
  ): Extract<TaskState, "REJECTED" | "FAILED"> {
    return reason === "user" || reason === "policy" ? "REJECTED" : "FAILED";
  }

  transitionTo(
    state: TaskState,
    options: TaskTransitionOptions = {},
  ): TaskEntity {
    TaskEntity.assertValidTransition(this.task.status.state, state);

    return new TaskEntity({
      ...this.task,
      status: {
        state,
        timestamp: options.timestamp ?? new Date().toISOString(),
        ...(options.message ? { message: options.message } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
    });
  }

  appendArtifact(artifact: Artifact): TaskEntity {
    if (TaskEntity.isTerminalState(this.task.status.state)) {
      return new TaskEntity({
        ...this.task,
        artifacts: [...this.task.artifacts],
      });
    }

    return new TaskEntity({
      ...this.task,
      artifacts: [...this.task.artifacts, artifact],
    });
  }

  appendMessage(message: A2AMessage): TaskEntity {
    return new TaskEntity({
      ...this.task,
      history: [...this.task.history, message],
    });
  }
}
