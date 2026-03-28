import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";

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
  message: A2AMessage;
  contextId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export function resolveTaskContextId(taskId: string, contextId?: string): string {
  return contextId ?? taskId;
}

export function createCanonicalTask(init: CanonicalTaskInit): Task {
  return {
    id: init.id,
    contextId: resolveTaskContextId(init.id, init.contextId),
    status: {
      state: "SUBMITTED",
      timestamp: init.timestamp ?? new Date().toISOString(),
    },
    artifacts: [],
    history: [init.message],
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
    throw new Error(`Invalid A2A task transition: ${from} -> ${to}`);
  }
}

export function createInputRequiredTaskMetadata(
  kind: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    awaitingInput: true,
    kind,
    ...details,
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
