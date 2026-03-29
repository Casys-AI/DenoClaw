import type { A2AMessage } from "../messaging/a2a/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import type { BrokerEnvelope } from "../shared/types.ts";

export interface RuntimeTaskSubmitPayload {
  taskId: string;
  /**
   * Canonical A2A task input message.
   * Prefer `taskMessage`; `message` remains a temporary alias for compatibility.
   */
  taskMessage?: A2AMessage;
  /** @deprecated Use `taskMessage`. */
  message?: A2AMessage;
  contextId?: string;
}

export interface RuntimeTaskContinuePayload {
  taskId: string;
  /**
   * Canonical A2A continuation message.
   * Prefer `continuationMessage`; `message` remains a temporary alias.
   */
  continuationMessage?: A2AMessage;
  /** @deprecated Use `continuationMessage`. */
  message?: A2AMessage;
  metadata?: Record<string, unknown>;
}

export type RuntimeTaskSubmitMessage = BrokerEnvelope<
  "task_submit",
  RuntimeTaskSubmitPayload
>;

export type RuntimeTaskContinueMessage = BrokerEnvelope<
  "task_continue",
  RuntimeTaskContinuePayload
>;

export type RuntimeTaskMessage =
  | RuntimeTaskSubmitMessage
  | RuntimeTaskContinueMessage;

export type CanonicalTaskEnvelope = RuntimeTaskMessage;
export type CanonicalTaskSubmitEnvelope = RuntimeTaskSubmitMessage;
export type CanonicalTaskContinueEnvelope = RuntimeTaskContinueMessage;

export function isRuntimeTaskMessage(
  msg: BrokerEnvelope,
): msg is RuntimeTaskMessage {
  return msg.type === "task_submit" || msg.type === "task_continue";
}

export function assertRuntimeTaskMessage(
  msg: BrokerEnvelope,
): asserts msg is RuntimeTaskMessage {
  if (isRuntimeTaskMessage(msg)) return;
  throw new DenoClawError(
    "INVALID_BROKER_MESSAGE",
    { type: msg.type, to: msg.to },
    "AgentRuntime only accepts canonical task_submit/task_continue broker envelopes",
  );
}

export function extractSubmitTaskMessage(
  payload: RuntimeTaskSubmitPayload,
): A2AMessage {
  const taskMessage = payload.taskMessage ?? payload.message;
  if (taskMessage) return taskMessage;

  throw new DenoClawError(
    "INVALID_BROKER_MESSAGE",
    { payloadKeys: Object.keys(payload) },
    "task_submit requires taskMessage (or legacy message alias)",
  );
}

export function extractContinuationTaskMessage(
  payload: RuntimeTaskContinuePayload,
): A2AMessage {
  const continuationMessage = payload.continuationMessage ?? payload.message;
  if (continuationMessage) return continuationMessage;

  throw new DenoClawError(
    "INVALID_BROKER_MESSAGE",
    { payloadKeys: Object.keys(payload) },
    "task_continue requires continuationMessage (or legacy message alias)",
  );
}
