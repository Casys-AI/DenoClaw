/**
 * Worker Protocol — internal runtime plumbing for Worker ↔ Main process communication.
 *
 * ## Classification (ADR-011)
 *
 * Each message type is classified as either:
 * - **infra** — runtime/lifecycle plumbing that must remain in the worker protocol
 * - **bridge** — compatibility shim for task-shaped messages that will migrate
 *   to canonical A2A task operations (submit/continue/cancel/stream)
 *
 * The canonical task contract lives in `src/messaging/a2a/`. The worker protocol
 * handles only runtime coordination: init, ready, shutdown, approval transport,
 * and observability hooks. Task semantics (submit, result, delegation) are
 * routed through `executeCanonicalWorkerTask()` in worker_entrypoint.ts.
 */
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

// ── Infra message types (permanent runtime plumbing) ─────

/** infra: Messages that are strictly runtime/lifecycle coordination. */
export type InfraRequestType = "init" | "ask_response" | "shutdown";
export type InfraResponseType = "ready" | "ask_approval" | "task_started" | "task_completed";

// ── Bridge message types (compatibility, slated for A2A migration) ──

/**
 * bridge: Messages that carry task-model semantics through the worker protocol.
 * These exist as a compatibility layer during the migration to canonical A2A
 * task operations. They delegate into executeCanonicalWorkerTask() internally
 * and will be replaced by A2A RuntimePort adapters.
 */
export type BridgeRequestType = "process" | "agent_deliver" | "agent_response";
export type BridgeResponseType = "result" | "error" | "agent_send" | "agent_result" | "agent_task";

// ── Main → Worker ────────────────────────────────────────

export type WorkerRequest =
  // infra: runtime lifecycle
  | {
    type: "init";
    agentId: string;
    config: WorkerConfig;
    kvPaths: WorkerKvPaths;
  }
  // infra: approval transport (ADR-010)
  | {
    type: "ask_response";
    requestId: string;
    approved: boolean;
    allowAlways?: boolean;
  }
  // infra: graceful shutdown
  | { type: "shutdown" }
  // bridge: task submission — delegates to executeCanonicalWorkerTask()
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
  // bridge: inter-agent task delegation
  | {
    type: "agent_deliver";
    requestId: string;
    fromAgent: string;
    message: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  // bridge: inter-agent response relay
  | {
    type: "agent_response";
    requestId: string;
    content: string;
    error?: boolean;
  };

// ── Worker → Main ────────────────────────────────────────

export type WorkerResponse =
  // infra: worker ready signal
  | { type: "ready"; agentId: string }
  // infra: approval request (ADR-010)
  | {
    type: "ask_approval";
    requestId: string;
    agentId: string;
    command: string;
    binary: string;
    reason: ApprovalReason;
  }
  // infra: observability — task lifecycle hooks
  | {
    type: "task_started";
    requestId: string;
    sessionId: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  | { type: "task_completed"; requestId: string }
  // bridge: task result — will be replaced by A2A task completion events
  | {
    type: "result";
    requestId: string;
    content: string;
    finishReason?: string;
  }
  // bridge: task error — will be replaced by A2A task failure events
  | { type: "error"; requestId: string; code: string; message: string }
  // bridge: inter-agent send request
  | {
    type: "agent_send";
    requestId: string;
    toAgent: string;
    message: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  // bridge: inter-agent result
  | {
    type: "agent_result";
    requestId: string;
    content: string;
    error?: boolean;
  }
  // bridge: inter-agent task observability
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
  };

// ── Classification helpers ───────────────────────────────

const INFRA_REQUEST_TYPES: ReadonlySet<InfraRequestType> = new Set([
  "init",
  "ask_response",
  "shutdown",
]);

const BRIDGE_REQUEST_TYPES: ReadonlySet<BridgeRequestType> = new Set([
  "process",
  "agent_deliver",
  "agent_response",
]);

const INFRA_RESPONSE_TYPES: ReadonlySet<InfraResponseType> = new Set([
  "ready",
  "ask_approval",
  "task_started",
  "task_completed",
]);

const BRIDGE_RESPONSE_TYPES: ReadonlySet<BridgeResponseType> = new Set([
  "result",
  "error",
  "agent_send",
  "agent_result",
  "agent_task",
]);

// test utilities
/** Returns true if this request message type is infra (permanent runtime plumbing). */
export function isInfraRequest(type: WorkerRequest["type"]): boolean {
  return INFRA_REQUEST_TYPES.has(type as InfraRequestType);
}

/** Returns true if this response message type is infra (permanent runtime plumbing). */
export function isInfraResponse(type: WorkerResponse["type"]): boolean {
  return INFRA_RESPONSE_TYPES.has(type as InfraResponseType);
}

/** Returns true if this request message type is a bridge (compatibility, slated for removal). */
export function isBridgeRequest(type: WorkerRequest["type"]): boolean {
  return BRIDGE_REQUEST_TYPES.has(type as BridgeRequestType);
}

/** Returns true if this response message type is a bridge (compatibility, slated for removal). */
export function isBridgeResponse(type: WorkerResponse["type"]): boolean {
  return BRIDGE_RESPONSE_TYPES.has(type as BridgeResponseType);
}
