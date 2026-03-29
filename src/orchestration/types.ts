/**
 * Protocol types for Broker ↔ Agent ↔ Tunnel communication.
 * These envelopes describe broker-level routing metadata; transport remains environment-dependent.
 */

import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import type {
  BrokerEnvelope,
  LLMResponse,
  SandboxPermission,
  StructuredError,
} from "../shared/types.ts";

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

export type BrokerLLMRequestMessage = BrokerEnvelope<
  "llm_request",
  LLMRequest
>;
export type BrokerLLMResponseMessage = BrokerEnvelope<
  "llm_response",
  LLMResponsePayload
>;
export type BrokerToolRequestMessage = BrokerEnvelope<
  "tool_request",
  ToolRequest
>;
export type BrokerToolResponseMessage = BrokerEnvelope<
  "tool_response",
  ToolResponsePayload
>;
export type BrokerTaskSubmitMessage = BrokerEnvelope<
  "task_submit",
  BrokerTaskSubmitPayload
>;
export type BrokerTaskContinueMessage = BrokerEnvelope<
  "task_continue",
  BrokerTaskContinuePayload
>;
export type BrokerTaskGetMessage = BrokerEnvelope<
  "task_get",
  BrokerTaskQueryPayload
>;
export type BrokerTaskCancelMessage = BrokerEnvelope<
  "task_cancel",
  BrokerTaskQueryPayload
>;
export type BrokerTaskResultMessage = BrokerEnvelope<
  "task_result",
  BrokerTaskResultPayload
>;
export type BrokerErrorMessage = BrokerEnvelope<"error", StructuredError>;

/** Broker-level runtime operations that are not canonical task semantics. */
export type BrokerRuntimeMessage =
  | BrokerLLMRequestMessage
  | BrokerLLMResponseMessage
  | BrokerToolRequestMessage
  | BrokerToolResponseMessage;

/** Canonical task-oriented broker messages. */
export type BrokerTaskMessage =
  | BrokerTaskSubmitMessage
  | BrokerTaskContinueMessage
  | BrokerTaskGetMessage
  | BrokerTaskCancelMessage
  | BrokerTaskResultMessage;

/**
 * Client/broker requests sent through BrokerTransport.
 *
 * Note: `task_result` is intentionally duplex here. It is used both as an
 * agent -> broker report and as a broker -> client canonical task reply.
 */
export type BrokerRequestMessage =
  | BrokerLLMRequestMessage
  | BrokerToolRequestMessage
  | BrokerTaskMessage;

/** Valid broker replies for BrokerTransport request/response flows. */
export type BrokerResponseMessage =
  | BrokerLLMResponseMessage
  | BrokerToolResponseMessage
  | BrokerTaskResultMessage
  | BrokerErrorMessage;

/**
 * Broker transport envelope union.
 *
 * ADR-011 boundary:
 * - task semantics live in canonical `task_*` operations / A2A payloads
 * - runtime execution operations (`llm_*`, `tool_*`) remain broker-level plumbing
 * - legacy task-shaped broker variants (`agent_message`, `agent_response`, `heartbeat`)
 *   have been removed from the orchestration contract
 */
export type BrokerMessage =
  | BrokerRuntimeMessage
  | BrokerTaskMessage
  | BrokerErrorMessage;

export type BrokerMessageType = BrokerMessage["type"];

export function isBrokerRuntimeMessage(
  message: BrokerMessage,
): message is BrokerRuntimeMessage {
  return message.type === "llm_request" || message.type === "llm_response" ||
    message.type === "tool_request" || message.type === "tool_response";
}

export function isBrokerTaskMessage(
  message: BrokerMessage,
): message is BrokerTaskMessage {
  return message.type === "task_submit" || message.type === "task_continue" ||
    message.type === "task_get" || message.type === "task_cancel" ||
    message.type === "task_result";
}

export function isBrokerErrorMessage(
  message: BrokerMessage,
): message is BrokerErrorMessage {
  return message.type === "error";
}

export function isBrokerRequestMessage(
  message: BrokerMessage,
): message is BrokerRequestMessage {
  return message.type === "llm_request" || message.type === "tool_request" ||
    isBrokerTaskMessage(message);
}

export function isBrokerResponseMessage(
  message: BrokerMessage,
): message is BrokerResponseMessage {
  return message.type === "llm_response" || message.type === "tool_response" ||
    message.type === "task_result" || isBrokerErrorMessage(message);
}

// ── Tunnel capabilities ──────────────────────────────────

export type TunnelType = "local" | "instance";

export interface TunnelCapabilities {
  tunnelId: string;
  type: TunnelType;
  // Local tunnel: expose tools
  tools: string[];
  /** Required permissions for each tool (ADR-005). Key = tool name, value = permissions. */
  toolPermissions?: Record<string, SandboxPermission[]>;
  // Instance tunnel: expose remote agents via broker-to-broker
  agents?: string[];
  allowedAgents: string[];
}
