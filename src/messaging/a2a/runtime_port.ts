import type {
  A2AMessage,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "./types.ts";
import { resolveTaskContextId } from "./internal_contract.ts";

/**
 * Transport-agnostic A2A runtime port.
 *
 * This abstracts transport boundaries (local postMessage, HTTP, SSE), not task
 * semantics. Canonical task invariants stay centralized in internal_contract.ts.
 */
export interface A2ARuntimePort {
  submitTask(request: SubmitTaskRequest): Promise<Task>;
  continueTask(request: ContinueTaskRequest): Promise<Task | null>;
  getTask(taskId: string): Promise<Task | null>;
  streamTaskEvents(taskId: string): AsyncIterable<RuntimeTaskEvent>;
  cancelTask(taskId: string): Promise<Task | null>;
}

export interface SubmitTaskRequest {
  taskId: string;
  message: A2AMessage;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface ContinueTaskRequest {
  taskId: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
}

export type RuntimeTaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export function resolveRuntimeTaskContextId(
  request: Pick<SubmitTaskRequest, "taskId" | "contextId">,
): string {
  return resolveTaskContextId(request.taskId, request.contextId);
}
