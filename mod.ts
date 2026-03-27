/**
 * DenoClaw — Deno-native AI agent framework.
 * Zero Node.js dependencies. Powered by Deno KV, Deno.cron, Deno.serve.
 *
 * Bounded contexts: agent, messaging, orchestration, llm, config, telemetry.
 */

// ── Agent domain ─────────────────────────────────────────
export { AgentLoop } from "./src/agent/loop.ts";
export { AgentRuntime } from "./src/agent/runtime.ts";
export { Memory } from "./src/agent/memory.ts";
export { KvdexMemory } from "./src/agent/memory_kvdex.ts";
export type { LongTermFact, MemoryPort } from "./src/agent/memory_port.ts";
export { WorkspaceLoader } from "./src/agent/workspace.ts";
export type { AgentWorkspace } from "./src/agent/workspace.ts";
export { ContextBuilder } from "./src/agent/context.ts";
export { SkillsLoader } from "./src/agent/skills.ts";
export { CronManager } from "./src/agent/cron.ts";
export { BaseTool, ToolRegistry } from "./src/agent/tools/registry.ts";
export { ShellTool } from "./src/agent/tools/shell.ts";
export { ReadFileTool, WriteFileTool } from "./src/agent/tools/file.ts";
export { WebFetchTool } from "./src/agent/tools/web.ts";
export { BUILTIN_TOOL_PERMISSIONS } from "./src/agent/tools/types.ts";
export type {
  AgentConfig,
  AgentDefaults,
  AgentResponse,
  AgentsConfig,
  ToolsConfig,
} from "./src/agent/types.ts";
export type { AgentLoopDeps } from "./src/agent/loop.ts";
export type { BuiltinToolName } from "./src/agent/tools/types.ts";

// ── Messaging domain ────────────────────────────────────
export { MessageBus } from "./src/messaging/bus.ts";
export { SessionManager } from "./src/messaging/session.ts";
export { ChannelManager } from "./src/messaging/channels/manager.ts";
export { BaseChannel } from "./src/messaging/channels/base.ts";
export { ConsoleChannel } from "./src/messaging/channels/console.ts";
export { TelegramChannel } from "./src/messaging/channels/telegram.ts";
export { WebhookChannel } from "./src/messaging/channels/webhook.ts";
export { A2AClient } from "./src/messaging/a2a/client.ts";
export { A2AServer } from "./src/messaging/a2a/server.ts";
export {
  generateAgentCard,
  generateAllCards,
} from "./src/messaging/a2a/card.ts";
export { TaskStore } from "./src/messaging/a2a/tasks.ts";
export { A2A_ERRORS, TERMINAL_STATES } from "./src/messaging/a2a/types.ts";
export type {
  A2AMessage,
  A2AMethod,
  A2ARole,
  AgentCard,
  AgentSkill,
  Artifact,
  DataPart,
  FilePart,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TextPart,
} from "./src/messaging/a2a/types.ts";
export type {
  ChannelMessage,
  ChannelsConfig,
  DiscordConfig,
  Session,
  TelegramConfig,
  WebhookConfig,
} from "./src/messaging/types.ts";

// ── Orchestration domain ─────────────────────────────────
export { AuthManager } from "./src/orchestration/auth.ts";
export type {
  AuthErrorCode,
  AuthResult,
  InviteToken,
  SessionToken,
} from "./src/orchestration/auth.ts";
export { BrokerClient } from "./src/orchestration/client.ts";
export { BrokerServer } from "./src/orchestration/broker.ts";
export type { BrokerServerDeps } from "./src/orchestration/broker.ts";
export { LocalRelay } from "./src/orchestration/relay.ts";
export { Gateway } from "./src/orchestration/gateway.ts";
export type { GatewayDeps } from "./src/orchestration/gateway.ts";
export { SandboxManager } from "./src/orchestration/sandbox.ts";

// ── LLM domain ───────────────────────────────────────────
export {
  AnthropicProvider,
  BaseProvider,
  OpenAICompatProvider,
} from "./src/llm/base.ts";
export { OllamaProvider } from "./src/llm/ollama.ts";
export { CLIProvider } from "./src/llm/cli.ts";
export { ProviderManager } from "./src/llm/manager.ts";
export type { ProviderConfig, ProvidersConfig } from "./src/llm/types.ts";

// ── Config ───────────────────────────────────────────────
export {
  createDefaultConfig,
  getConfig,
  getConfigOrDefault,
  loadConfig,
  saveConfig,
} from "./src/config/loader.ts";
export type { Config } from "./src/config/types.ts";

// ── Telemetry ────────────────────────────────────────────
export {
  initTelemetry,
  MetricsCollector,
  spanAgentLoop,
  spanBusPublish,
  spanLLMCall,
  spanToolCall,
  withSpan,
} from "./src/telemetry/mod.ts";
export type { AgentMetrics } from "./src/telemetry/metrics.ts";

// ── Shared kernel ────────────────────────────────────────
export type {
  AgentBrokerPort,
  AgentEntry,
  BrokerEnvelope,
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
} from "./src/shared/types.ts";
export type { CronJob, Skill } from "./src/agent/types.ts";
export {
  ChannelError,
  ConfigError,
  DenoClawError,
  ProviderError,
  ToolError,
} from "./src/shared/errors.ts";
