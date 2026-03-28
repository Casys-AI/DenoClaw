/**
 * Shared Kernel — types cross-domain utilisés par 3+ bounded contexts.
 *
 * Seuls les types réellement partagés vivent ici.
 * Les types domain-specific vivent dans leur domaine (agent/types.ts, messaging/types.ts, etc.).
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

// ── Ports (interfaces pour DI cross-domain sans violation de boundary) ────

/** Message enveloppe pour la communication inter-agent via le broker. */
export interface BrokerEnvelope {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  timestamp: string;
}

/**
 * Port d'accès au broker pour les agents (DI).
 * L'agent dépend de cette interface, pas du BrokerClient concret.
 * Résout la violation de boundary agent/ → orchestration/.
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
  sendToAgent(
    targetAgentId: string,
    instruction: string,
    data?: unknown,
  ): Promise<BrokerEnvelope>;
  close(): void;
}

// ── Sandbox permissions (cross-domain: utilisé par agent/tools, orchestration, config) ─

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
  toolsConfig?: { restrictToWorkspace?: boolean };
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

// ── Agent registry (cross-domain: utilisé par orchestration, messaging/a2a, cli, config) ─

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
  // A2A peers (ADR-006) — fermé par défaut
  peers?: string[]; // agents à qui je peux envoyer des Tasks
  acceptFrom?: string[]; // agents dont j'accepte des Tasks ("*" = tous)
  // Channels — d'où je reçois des messages utilisateur
  channels?: string[]; // noms des channels assignés
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

export interface AgentTaskEntry {
  id: string;
  from: string;
  to: string;
  message: string;
  status: string;
  result?: string;
  traceId?: string;
  contextId?: string;
  timestamp: string;
}
