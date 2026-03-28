import type { AgentDefaults, ToolsConfig } from "./types.ts";
import type { ProvidersConfig } from "../llm/types.ts";
import type { AgentEntry, ApprovalReason } from "../shared/types.ts";

/** Projection minimale de Config envoyée au Worker (JSON-serializable) */
export interface WorkerConfig {
  agents: {
    defaults: AgentDefaults;
    registry?: Record<string, AgentEntry>;
  };
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
  | {
    type: "init";
    agentId: string;
    config: WorkerConfig;
    kvPaths: WorkerKvPaths;
  }
  | {
    type: "process";
    requestId: string;
    sessionId: string;
    message: string;
    model?: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  | {
    type: "agent_deliver";
    requestId: string;
    fromAgent: string;
    message: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  | {
    type: "agent_response";
    requestId: string;
    content: string;
    error?: boolean;
  }
  | {
    type: "ask_response";
    requestId: string;
    approved: boolean;
    allowAlways?: boolean;
  }
  | { type: "shutdown" };

// ── Worker → Main ────────────────────────────────────────

export type WorkerResponse =
  | { type: "ready"; agentId: string }
  | {
    type: "result";
    requestId: string;
    content: string;
    finishReason?: string;
  }
  | { type: "error"; requestId: string; code: string; message: string }
  | {
    type: "agent_send";
    requestId: string;
    toAgent: string;
    message: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  | {
    type: "agent_result";
    requestId: string;
    content: string;
    error?: boolean;
  }
  | {
    type: "task_started";
    requestId: string;
    sessionId: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  | { type: "task_completed"; requestId: string }
  | {
    type: "agent_task";
    taskId: string;
    from: string;
    to: string;
    message: string;
    status: string;
    result?: string;
    traceId?: string;
    contextId?: string;
  }
  | {
    type: "ask_approval";
    requestId: string;
    agentId: string;
    command: string;
    binary: string;
    reason: ApprovalReason;
  };
