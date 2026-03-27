import type { AgentDefaults, ToolsConfig } from "./types.ts";
import type { ProvidersConfig } from "../llm/types.ts";

/** Projection minimale de Config envoyée au Worker (JSON-serializable) */
export interface WorkerConfig {
  agents: { defaults: AgentDefaults };
  providers: ProvidersConfig;
  tools: ToolsConfig;
}

/** KV paths pour le Worker */
export interface WorkerKvPaths {
  private: string;
  shared: string;
}

// ── Main → Worker ────────────────────────────────────────

export type WorkerRequest =
  | { type: "init"; agentId: string; config: WorkerConfig; kvPaths: WorkerKvPaths }
  | { type: "process"; requestId: string; sessionId: string; message: string; model?: string }
  | { type: "shutdown" };

// ── Worker → Main ────────────────────────────────────────

export type WorkerResponse =
  | { type: "ready"; agentId: string }
  | { type: "result"; requestId: string; content: string; finishReason?: string }
  | { type: "error"; requestId: string; code: string; message: string };
