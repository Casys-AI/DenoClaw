/**
 * Shared Kernel — cross-domain types used by 3+ bounded contexts.
 *
 * Only truly shared types belong here.
 * Domain-specific types live in their own domain (agent/types.ts, messaging/types.ts, etc.).
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
 * Resolves the agent/ → orchestration/ boundary violation.
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

// ── Sandbox permissions (cross-domain: used by agent/tools, orchestration, config) ─

export type SandboxPermission =
  | "read"
  | "write"
  | "run"
  | "net"
  | "env"
  | "ffi";

// ── Exec Policy (ADR-010) — discriminated union on `security` ─

export type ApprovalReason =
  | "not-in-allowlist"
  | "shell-operator"
  | "inline-eval"
  | "always-ask";

interface ExecPolicyBase {
  ask: "off" | "on-miss" | "always";
  askFallback?: "deny" | "allowlist";
}

interface ExecPolicyDeny extends ExecPolicyBase {
  security: "deny";
}

interface ExecPolicyFull extends ExecPolicyBase {
  security: "full";
  /** Additional env prefixes to strip (on top of LD_*, DYLD_*) */
  envFilter?: string[];
}

interface ExecPolicyAllowlist extends ExecPolicyBase {
  security: "allowlist";
  allowedCommands?: string[];
  /** Keyword blocklist — matches anywhere in command string (intentionally aggressive) */
  deniedCommands?: string[];
  /** Additional env prefixes to strip (on top of LD_*, DYLD_*) */
  envFilter?: string[];
  /** Allow -c/-e flags on interpreters (default: false = blocked) */
  allowInlineEval?: boolean;
}

export type ExecPolicy = ExecPolicyDeny | ExecPolicyFull | ExecPolicyAllowlist;

export interface ApprovalRequest {
  requestId: string;
  command: string;
  binary: string;
  reason: ApprovalReason;
}

export interface ApprovalResponse {
  approved: boolean;
  allowAlways?: boolean;
}

// ── Sandbox Backend (ADR-010) ────────────────────────────

export interface SandboxExecRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy: ExecPolicy;
  toolsConfig?: { restrictToWorkspace?: boolean; workspaceDir?: string; agentId?: string };
  onAskApproval?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
}

export interface SandboxBackend {
  readonly kind: "local" | "cloud";
  readonly supportsFullShell: boolean;
  execute(req: SandboxExecRequest): Promise<ToolResult>;
  close(): Promise<void>;
}

// ── Sandbox Config ───────────────────────────────────────

export interface SandboxConfig {
  backend?: "local" | "cloud";
  allowedPermissions: SandboxPermission[];
  networkAllow?: string[];
  maxDurationSec?: number;
  execPolicy?: ExecPolicy;
  approvalTimeoutSec?: number;
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

// ── Observability types (cross-domain: written by agent/, read by orchestration/) ──

export interface AgentStatusValue {
  status: "running" | "alive" | "stopped";
  startedAt?: string;
  lastHeartbeat?: string;
  stoppedAt?: string;
  model?: string;
}

export interface ActiveTaskEntry {
  taskId: string;
  sessionId: string;
  traceId?: string;
  contextId?: string;
  startedAt: string;
}

export interface AgentStatusEntry {
  agentId: string;
  status: "running" | "alive" | "stopped";
  startedAt?: string;
  lastHeartbeat?: string;
  stoppedAt?: string;
  model?: string;
  activeTask?: ActiveTaskEntry | null;
}

export interface TaskObservationEntry {
  taskId: string;
  from: string;
  to: string;
  message: string;
  status: string;
  result?: string;
  traceId?: string;
  contextId?: string;
  timestamp: string;
}
