/**
 * BACKWARD-COMPAT SHIM — sera supprimé en Phase 9.
 *
 * Tous les types cross-domain vivent maintenant dans src/shared/types.ts.
 * Les types domain-specific seront migrés dans leur domaine (phases 2-5).
 * Ce fichier ré-exporte tout pour ne pas casser les imports existants.
 */

// ── Cross-domain types (shared kernel) ───────────────────

export type {
  AgentConfig,
  AgentEntry,
  AgentResponse,
  ChannelRouting,
  LLMResponse,
  Message,
  MessageRole,
  SandboxConfig,
  SandboxPermission,
  StructuredError,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./shared/types.ts";

// ── Domain-specific types (migrés dans phases 2-5) ───────

// Agent domain (→ agent/types.ts en phase 2)
export interface Skill {
  name: string;
  description: string;
  content: string;
  path: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface AgentDefaults {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
  sandbox?: import("./shared/types.ts").SandboxConfig;
}

export interface ToolsConfig {
  restrictToWorkspace?: boolean;
  allowedCommands?: string[];
  deniedCommands?: string[];
}

export interface AgentsConfig {
  defaults: AgentDefaults;
  registry?: Record<string, import("./shared/types.ts").AgentEntry>;
}

// Agent tools (→ agent/tools/types.ts en phase 2)
export type BuiltinToolName = "shell" | "read_file" | "write_file" | "web_fetch";

export const BUILTIN_TOOL_PERMISSIONS: Readonly<Record<BuiltinToolName, readonly import("./shared/types.ts").SandboxPermission[]>> = {
  shell: ["run"],
  read_file: ["read"],
  write_file: ["write"],
  web_fetch: ["net"],
} as const;

// Messaging domain (→ messaging/types.ts en phase 4)
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

// LLM domain (→ llm/types.ts en phase 3)
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

// Config aggregate (→ config/types.ts en phase 6)
export interface Config {
  providers: ProvidersConfig;
  agents: AgentsConfig;
  tools: ToolsConfig;
  channels: ChannelsConfig;
  gateway?: { port: number };
}
