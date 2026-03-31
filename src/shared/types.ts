/**
 * Shared Kernel — cross-domain types used by 3+ bounded contexts.
 *
 * Only truly shared types belong here.
 * Domain-specific types live in their own domain (agent/types.ts, messaging/types.ts, etc.).
 */

export type {
  CommandMode,
  ExecPolicy,
  SandboxBackend,
  SandboxExecRequest,
  ShellConfig,
} from "../agent/sandbox_types.ts";
export type {
  ActiveTaskEntry,
  AgentStatusEntry,
  AgentStatusValue,
  TaskObservationEntry,
} from "../orchestration/monitoring_types.ts";

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
 * Resolves the agent/ → orchestration/ boundary violation.
 */
export interface AgentLlmToolPort {
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

export interface AgentCanonicalTaskPort<TTask = unknown> {
  getTask(taskId: string): Promise<TTask | null>;
  reportTaskResult(task: TTask): Promise<TTask>;
}

/**
 * Backward-compatible aggregate port used by adapters that implement
 * both LLM/tooling and canonical task operations.
 */
export interface AgentBrokerPort<TTask = unknown>
  extends AgentLlmToolPort, AgentCanonicalTaskPort<TTask> {}

// ── Sandbox permissions (cross-domain: used by agent/tools, orchestration, config) ─

export type SandboxPermission =
  | "read"
  | "write"
  | "run"
  | "net"
  | "env"
  | "ffi";

export interface SandboxPrivilegeElevationConfig {
  enabled?: boolean;
  scopes?: import("./privilege_elevation.ts").PrivilegeElevationScope[];
  requestTimeoutSec?: number;
  sessionGrantTtlSec?: number;
}

// ── Sandbox Config ───────────────────────────────────────

export interface SandboxConfig {
  backend?: "local" | "cloud";
  allowedPermissions: SandboxPermission[];
  networkAllow?: string[];
  maxDurationSec?: number;
  execPolicy?: import("../agent/sandbox_types.ts").ExecPolicy;
  shell?: import("../agent/sandbox_types.ts").ShellConfig;
  privilegeElevation?: SandboxPrivilegeElevationConfig;
}

// ── Agent registry (cross-domain: used by orchestration, messaging/a2a, cli, config) ─

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
  // Sandbox (ADR-005)
  sandbox?: SandboxConfig;
  // A2A peers (ADR-006) — closed by default
  peers?: string[]; // agents I can send Tasks to
  acceptFrom?: string[]; // agents I accept Tasks from ("*" = all)
  // Channels — where I receive user messages from
  channels?: string[]; // assigned channel names
  channelRouting?: ChannelRouting;
}
