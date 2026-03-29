/**
 * Shared Kernel — cross-domain types used by 3+ bounded contexts.
 *
 * Only truly shared types belong here.
 * Domain-specific types live in their own domain.
 */

// ── Messages ──────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ── Tool system ───────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface StructuredError {
  code: string;
  context?: Record<string, unknown>;
  recovery?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: StructuredError;
}

// ── LLM ───────────────────────────────────────────────────

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ── Ports (interfaces for cross-domain DI without boundary violations) ────

/** Message envelope for broker-routed communication. */
export interface BrokerEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  id: string;
  from: string;
  to: string;
  type: TType;
  payload: TPayload;
  timestamp: string;
}

/**
 * Broker access port for agents (DI).
 * The agent depends on this interface, not the concrete BrokerClient.
 */
export interface AgentBrokerPort {
  startListening(): Promise<void>;
  complete(
    messages: Message[],
    model: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse>;
  execTool(
    tool: string,
    args: Record<string, unknown>,
    correlation?: { taskId?: string; contextId?: string },
  ): Promise<ToolResult>;
  close(): void;
}

// ── Sandbox permissions (cross-domain) ───────────────────

export type SandboxPermission =
  | "read"
  | "write"
  | "run"
  | "net"
  | "env"
  | "ffi";

// ── Sandbox Config (shared, used by config + agent + orchestration) ─────

import type { ExecPolicy } from "../agent/sandbox_types.ts";

export interface SandboxConfig {
  backend?: "local" | "cloud";
  allowedPermissions: SandboxPermission[];
  networkAllow?: string[];
  maxDurationSec?: number;
  execPolicy?: ExecPolicy;
  approvalTimeoutSec?: number;
}

// ── Agent registry (cross-domain: orchestration, messaging/a2a, cli, config) ─

export type ChannelRouting =
  | "direct"
  | "round-robin"
  | "by-intent"
  | "broadcast";

export interface AgentEntry {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  description?: string;
  sandbox?: SandboxConfig;
  peers?: string[];
  acceptFrom?: string[];
  channels?: string[];
  channelRouting?: ChannelRouting;
}

// ── Temporary compatibility re-exports (to be removed progressively) ─────

export type {
  ApprovalReason,
  ApprovalRequest,
  ApprovalResponse,
  ExecPolicy,
  SandboxBackend,
  SandboxExecRequest,
} from "../agent/sandbox_types.ts";

export type {
  ActiveTaskEntry,
  AgentStatusEntry,
  AgentStatusValue,
  TaskObservationEntry,
} from "../orchestration/monitoring_types.ts";
