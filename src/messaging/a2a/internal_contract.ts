import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import { DenoClawError } from "../../shared/errors.ts";

export const ALLOWED_TASK_STATE_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
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
  /**
   * First user intent message that initializes the canonical task lifecycle.
   * Prefer `initialMessage`; `message` is a temporary alias.
   */
  initialMessage?: A2AMessage;
  /** @deprecated Use `initialMessage`. */
  message?: A2AMessage;
  contextId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface TaskTransitionOptions {
  /**
   * Canonical status update message attached to the next transition.
   * Prefer `statusMessage`; `message` is a temporary alias.
   */
  statusMessage?: A2AMessage;
  /** @deprecated Use `statusMessage`. */
  message?: A2AMessage;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export function resolveTaskContextId(taskId: string, contextId?: string): string {
  return contextId ?? taskId;
}

export function createCanonicalTask(init: CanonicalTaskInit): Task {
  const initialMessage = init.initialMessage ?? init.message;
  if (!initialMessage) {
    throw new DenoClawError(
      "INVALID_TASK_TRANSITION",
      { taskId: init.id },
      "createCanonicalTask requires an initialMessage",
    );
  }

  return {
    id: init.id,
    contextId: resolveTaskContextId(init.id, init.contextId),
    status: {
      state: "SUBMITTED",
      timestamp: init.timestamp ?? new Date().toISOString(),
    },
    artifacts: [],
    history: [initialMessage],
    metadata: init.metadata,
  };
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransitionTaskState(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TASK_STATE_TRANSITIONS[from].includes(to);
}

export function assertValidTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTaskState(from, to)) {
    throw new DenoClawError(
      "INVALID_TASK_TRANSITION",
      { from, to },
      "Check allowed state transitions in A2A contract",
    );
  }
}

export function transitionTask(
  task: Task,
  state: TaskState,
  options: TaskTransitionOptions = {},
): Task {
  assertValidTaskTransition(task.status.state, state);
  const statusMessage = options.statusMessage ?? options.message;

  return {
    ...task,
    status: {
      state,
      timestamp: options.timestamp ?? new Date().toISOString(),
      ...(statusMessage ? { message: statusMessage } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
  };
}

export function classifyRefusalTerminalState(
  reason: RefusalTerminalReason,
): Extract<TaskState, "REJECTED" | "FAILED"> {
  return reason === "user" || reason === "policy" ? "REJECTED" : "FAILED";
}

export function appendArtifactToTask(task: Task, artifact: Artifact): Task {
  if (isTerminalTaskState(task.status.state)) {
    return {
      ...task,
      artifacts: [...task.artifacts],
    };
  }

  return {
    ...task,
    artifacts: [...task.artifacts, artifact],
  };
}
