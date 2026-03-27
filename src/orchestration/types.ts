/**
 * Protocol types for Broker ↔ Agent ↔ Tunnel communication.
 * All messages go through KV Queues as JSON.
 */

import type { SandboxPermission } from "../shared/types.ts";

// ── Message envelope ─────────────────────────────────────

export type BrokerMessageType =
  | "llm_request"
  | "llm_response"
  | "tool_request"
  | "tool_response"
  | "agent_message"
  | "agent_response"
  | "heartbeat"
  | "error";

export interface BrokerMessage {
  id: string;
  from: string;
  to: string;
  type: BrokerMessageType;
  payload: unknown;
  timestamp: string;
}

// ── LLM ──────────────────────────────────────────────────

export interface LLMRequest {
  messages: { role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] }[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
}

export interface LLMResponsePayload {
  content: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ── Tool execution ───────────────────────────────────────

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResponsePayload {
  success: boolean;
  output: string;
  error?: { code: string; context?: Record<string, unknown>; recovery?: string };
}

// ── Inter-agent ──────────────────────────────────────────

export interface AgentMessagePayload {
  instruction: string;
  data?: unknown;
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
