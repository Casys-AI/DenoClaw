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

// ── Agent (cross-domain: utilisé par agent, orchestration, messaging, cli) ─

export interface AgentConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
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

// ── Sandbox permissions (cross-domain: utilisé par agent/tools, orchestration, config) ─

export type SandboxPermission = "read" | "write" | "run" | "net" | "env" | "ffi";

export interface SandboxConfig {
  allowedPermissions: SandboxPermission[];
  networkAllow?: string[];
  maxDurationSec?: number;
}

// ── Agent registry (cross-domain: utilisé par orchestration, messaging/a2a, cli, config) ─

export type ChannelRouting = "direct" | "round-robin" | "by-intent" | "broadcast";

export interface AgentEntry {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  description?: string;
  // Sandbox (ADR-005)
  sandbox?: SandboxConfig;
  // A2A peers (ADR-006) — fermé par défaut
  peers?: string[];              // agents à qui je peux envoyer des Tasks
  acceptFrom?: string[];         // agents dont j'accepte des Tasks ("*" = tous)
  // Channels — d'où je reçois des messages utilisateur
  channels?: string[];           // noms des channels assignés
  channelRouting?: ChannelRouting;
}
