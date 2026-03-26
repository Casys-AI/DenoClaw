/**
 * DenoClaw — Deno-native AI agent, inspired by nano-claw.
 * Zero external dependencies. Powered by Deno KV, Deno.cron, Deno.serve.
 */

export { AgentLoop } from "./src/agent/loop.ts";
export { Memory } from "./src/agent/memory.ts";
export { ContextBuilder } from "./src/agent/context.ts";
export { SkillsLoader } from "./src/agent/skills.ts";
export { BaseTool, ToolRegistry } from "./src/agent/tools/registry.ts";
export { ShellTool } from "./src/agent/tools/shell.ts";
export { ReadFileTool, WriteFileTool } from "./src/agent/tools/file.ts";
export { WebFetchTool } from "./src/agent/tools/web.ts";

export { AnthropicProvider, BaseProvider, OpenAICompatProvider } from "./src/providers/base.ts";
export { CLIProvider } from "./src/providers/cli.ts";
export { ProviderManager } from "./src/providers/manager.ts";

export { MessageBus, getMessageBus } from "./src/bus/mod.ts";
export { SessionManager, getSessionManager } from "./src/session/mod.ts";
export { ChannelManager, getChannelManager } from "./src/channels/manager.ts";
export { BaseChannel } from "./src/channels/base.ts";
export { ConsoleChannel } from "./src/channels/console.ts";
export { TelegramChannel } from "./src/channels/telegram.ts";
export { WebhookChannel } from "./src/channels/webhook.ts";
export { Gateway } from "./src/gateway/mod.ts";
export { CronManager } from "./src/cron/mod.ts";

export { getConfig, getConfigOrDefault, loadConfig, saveConfig } from "./src/config/mod.ts";

export { SandboxManager } from "./src/sandbox/mod.ts";
export { A2AClient } from "./src/a2a/client.ts";
export { A2AServer } from "./src/a2a/server.ts";
export { generateAgentCard, generateAllCards } from "./src/a2a/card.ts";
export { TaskStore } from "./src/a2a/tasks.ts";

export { BrokerClient } from "./src/broker/client.ts";
export { BrokerServer } from "./src/broker/server.ts";
export { LocalRelay } from "./src/relay/local.ts";
export { AgentRuntime } from "./src/subhosting/agent_runtime.ts";
export { initTelemetry, MetricsCollector, spanAgentLoop, spanBusPublish, spanLLMCall, spanToolCall, withSpan } from "./src/telemetry/mod.ts";
export type { AgentMetrics } from "./src/telemetry/metrics.ts";

export type {
  AgentConfig,
  AgentResponse,
  ChannelMessage,
  Config,
  CronJob,
  LLMResponse,
  Message,
  Session,
  Skill,
  StructuredError,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./src/types.ts";

export { ChannelError, ConfigError, DenoClawError, ProviderError, ToolError } from "./src/utils/errors.ts";
