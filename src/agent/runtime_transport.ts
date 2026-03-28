import type { A2AMessage } from "../messaging/a2a/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import type { BrokerEnvelope } from "../shared/types.ts";

export interface RuntimeTaskSubmitPayload {
  taskId: string;
  message: A2AMessage;
  contextId?: string;
}

export interface RuntimeTaskContinuePayload {
  taskId: string;
  message: A2AMessage;
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
