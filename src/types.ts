/**
 * Core type definitions for DenoClaw
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

// ── Agent ─────────────────────────────────────────────────

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

// ── Sessions & Channels ──────────────────────────────────

export interface Session {
  id: string;
  userId: string;
  channelType: string;
  createdAt: string;
  lastActivity: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelMessage {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  channelType: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Sandbox permissions ───────────────────────────────────

export type SandboxPermission = "read" | "write" | "run" | "net" | "env" | "ffi";

/** Noms des outils built-in. Ajouter un outil ici sans mettre à jour la map → erreur de compilation. */
export type BuiltinToolName = "shell" | "read_file" | "write_file" | "web_fetch";

/**
 * Permissions requises par chaque outil built-in (ADR-005). Source unique de vérité.
 *
 * Placé dans types.ts (et non agent/tools/) car le broker doit y accéder
 * et la boundary d'import interdit broker → agent/tools.
 */
export const BUILTIN_TOOL_PERMISSIONS: Readonly<Record<BuiltinToolName, readonly SandboxPermission[]>> = {
  shell: ["run"],
  read_file: ["read"],
  write_file: ["write"],
  web_fetch: ["net"],
} as const;

export interface SandboxConfig {
  allowedPermissions: SandboxPermission[];
  networkAllow?: string[];
  maxDurationSec?: number;
}

// ── Skills ────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  content: string;
  path: string;
}

// ── Cron ──────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

// ── Config ────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  apiBase?: string;
  enabled?: boolean;
}

export interface ProvidersConfig {
  openrouter?: ProviderConfig;
  anthropic?: ProviderConfig;
  openai?: ProviderConfig;
  deepseek?: ProviderConfig;
  groq?: ProviderConfig;
  gemini?: ProviderConfig;
  [key: string]: ProviderConfig | undefined;
}

export interface AgentDefaults {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
  sandbox?: SandboxConfig;
}

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

export interface ToolsConfig {
  restrictToWorkspace?: boolean;
  allowedCommands?: string[];
  deniedCommands?: string[];
}

export interface TelegramConfig {
  enabled: boolean;
  token?: string;
  allowFrom?: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  token?: string;
  allowFrom?: string[];
}

export interface WebhookConfig {
  enabled: boolean;
  port?: number;
  secret?: string;
}

export interface ChannelsConfig {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  webhook?: WebhookConfig;
}

export interface AgentsConfig {
  defaults: AgentDefaults;
  registry?: Record<string, AgentEntry>;
}

export interface Config {
  providers: ProvidersConfig;
  agents: AgentsConfig;
  tools: ToolsConfig;
  channels: ChannelsConfig;
  gateway?: { port: number };
}
