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

export interface Config {
  providers: ProvidersConfig;
  agents: { defaults: AgentDefaults };
  tools: ToolsConfig;
  channels: ChannelsConfig;
  gateway?: { port: number };
}
