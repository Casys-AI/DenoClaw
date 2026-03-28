/**
 * Protocol types for Broker ↔ Agent ↔ Tunnel communication.
 * These envelopes describe broker-level routing metadata; transport remains environment-dependent.
 */

import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import type {
  LLMResponse,
  SandboxPermission,
  StructuredError,
} from "../shared/types.ts";

interface BrokerEnvelopeBase<TType extends string, TPayload> {
  id: string;
  from: string;
  to: string;
  type: TType;
  payload: TPayload;
  timestamp: string;
}

// ── LLM ──────────────────────────────────────────────────

export interface LLMRequest {
  messages: {
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
}

export type LLMResponsePayload = LLMResponse;

// ── Tool execution ───────────────────────────────────────

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
  taskId?: string;
  contextId?: string;
}

export interface ToolResponsePayload {
  success: boolean;
  output: string;
  error?: StructuredError;
}

// ── Canonical task operations ────────────────────────────

export interface BrokerTaskSubmitPayload {
  targetAgent: string;
  taskId: string;
  message: A2AMessage;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface BrokerTaskContinuePayload {
  taskId: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
}

export interface BrokerTaskQueryPayload {
  taskId: string;
}

export interface BrokerTaskResultPayload {
  task: Task | null;
}

// ── Message envelope union ───────────────────────────────

export type BrokerLLMRequestMessage = BrokerEnvelopeBase<"llm_request", LLMRequest>;
export type BrokerLLMResponseMessage = BrokerEnvelopeBase<
  "llm_response",
  LLMResponsePayload
>;
export type BrokerToolRequestMessage = BrokerEnvelopeBase<"tool_request", ToolRequest>;
export type BrokerToolResponseMessage = BrokerEnvelopeBase<
  "tool_response",
  ToolResponsePayload
>;
export type BrokerTaskSubmitMessage = BrokerEnvelopeBase<
  "task_submit",
  BrokerTaskSubmitPayload
>;
export type BrokerTaskContinueMessage = BrokerEnvelopeBase<
  "task_continue",
  BrokerTaskContinuePayload
>;
export type BrokerTaskGetMessage = BrokerEnvelopeBase<"task_get", BrokerTaskQueryPayload>;
export type BrokerTaskCancelMessage = BrokerEnvelopeBase<
  "task_cancel",
  BrokerTaskQueryPayload
>;
export type BrokerTaskResultMessage = BrokerEnvelopeBase<
  "task_result",
  BrokerTaskResultPayload
>;
export type BrokerHeartbeatMessage = BrokerEnvelopeBase<
  "heartbeat",
  Record<string, never>
>;
export type BrokerErrorMessage = BrokerEnvelopeBase<"error", StructuredError>;

export type BrokerMessage =
  | BrokerLLMRequestMessage
  | BrokerLLMResponseMessage
  | BrokerToolRequestMessage
  | BrokerToolResponseMessage
  | BrokerEnvelopeBase<"agent_message", {
    targetAgent?: string;
    instruction: string;
    data?: unknown;
    taskId?: string;
    contextId?: string;
    metadata?: Record<string, unknown>;
  }>
  | BrokerEnvelopeBase<"agent_response", {
    accepted: true;
    targetAgent: string;
    taskId?: string;
    contextId?: string;
  }>
  | BrokerTaskSubmitMessage
  | BrokerTaskContinueMessage
  | BrokerTaskGetMessage
  | BrokerTaskCancelMessage
  | BrokerTaskResultMessage
  | BrokerHeartbeatMessage
  | BrokerErrorMessage;

export type BrokerMessageType = BrokerMessage["type"];

export function isBrokerErrorMessage(
  message: BrokerMessage,
): message is BrokerErrorMessage {
  return message.type === "error";
}

// ── Tunnel capabilities ──────────────────────────────────

export type TunnelType = "local" | "instance";

export interface TunnelCapabilities {
  tunnelId: string;
  type: TunnelType;
  // Local tunnel: expose tools + auth flow
  tools: string[];
  /** Permissions requises par chaque outil (ADR-005). Clé = nom outil, valeur = permissions. */
  toolPermissions?: Record<string, SandboxPermission[]>;
  supportsAuth?: boolean;
  // Instance tunnel: expose remote agents via broker-to-broker
  agents?: string[];
  allowedAgents: string[];
}
