import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import {
  ALLOWED_TASK_STATE_TRANSITIONS,
  type CanonicalTaskInit,
  type RefusalTerminalReason,
  TaskEntity,
  type TaskTransitionOptions,
} from "./task_entity.ts";

export {
  ALLOWED_TASK_STATE_TRANSITIONS,
  type CanonicalTaskInit,
  type RefusalTerminalReason,
  type TaskTransitionOptions,
};

export function resolveTaskContextId(taskId: string, contextId?: string): string {
  return TaskEntity.resolveContextId(taskId, contextId);
}

export function createCanonicalTask(init: CanonicalTaskInit): Task {
  return TaskEntity.createCanonical(init);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TaskEntity.isTerminalState(state);
}

export function canTransitionTaskState(from: TaskState, to: TaskState): boolean {
  return TaskEntity.canTransitionState(from, to);
}

export function assertValidTaskTransition(from: TaskState, to: TaskState): void {
  TaskEntity.assertValidTransition(from, to);
}

export function transitionTask(
  task: Task,
  state: TaskState,
  options: TaskTransitionOptions = {},
): Task {
  return new TaskEntity(task).transitionTo(state, options).task;
}

export function classifyRefusalTerminalState(
  reason: RefusalTerminalReason,
): Extract<TaskState, "REJECTED" | "FAILED"> {
  return TaskEntity.classifyRefusalTerminalState(reason);
}

export function appendArtifactToTask(task: Task, artifact: Artifact): Task {
  return new TaskEntity(task).appendArtifact(artifact).task;
}
