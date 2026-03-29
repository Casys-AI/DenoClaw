/**
 * Worker Protocol — internal runtime plumbing for Worker ↔ Main process communication.
 *
 * ## Classification (ADR-011)
 *
 * Each message type is classified as either:
 * - **infra** — runtime/lifecycle plumbing that must remain in the worker protocol
 * - **execution** — local run/delegation plumbing that remains internal to the
 *   worker transport and does not define a second task contract
 *
 * The canonical task contract lives in `src/messaging/a2a/`. The worker protocol
 * handles only runtime coordination: init, ready, shutdown, approval transport,
 * and observability hooks. Task semantics (submit, continue, result) are
 * routed through `executeCanonicalWorkerTask()` in worker_entrypoint.ts.
 */
import type { AgentDefaults, ToolsConfig } from "./types.ts";
import type { ProvidersConfig } from "../llm/types.ts";
import type { AgentEntry, ApprovalReason } from "../shared/types.ts";

/** Minimal Config projection sent to the Worker (JSON-serializable). */
export interface WorkerConfig {
  agents: {
    defaults: AgentDefaults;
    registry?: Record<string, AgentEntry>;
  };
  providers: ProvidersConfig;
  tools: ToolsConfig;
}

/** KV paths for the Worker. */
export interface WorkerKvPaths {
  private: string;
  shared: string;
}

// ── Infra message types (permanent runtime plumbing) ─────

/** infra: Messages that are strictly runtime/lifecycle coordination. */
export type InfraRequestType = "init" | "ask_response" | "shutdown";
export type InfraResponseType =
  | "ready"
  | "ask_approval"
  | "task_started"
  | "task_completed";

// ── Execution message types (internal runtime/delegation plumbing) ──

/**
 * execution: Messages that trigger local task execution or peer delegation
 * through the worker transport. They remain internal plumbing, while the
 * canonical task contract continues to live in A2A.
 */
export type ExecutionRequestType = "run" | "peer_deliver" | "peer_response";
export type ExecutionResponseType =
  | "run_result"
  | "run_error"
  | "peer_send"
  | "peer_result"
  | "task_observe";

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
  // execution: local task execution request
  | {
    type: "run";
    requestId: string;
    sessionId: string;
    message: string;
    model?: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  // execution: main process delivers a peer request to a target worker
  | {
    type: "peer_deliver";
    requestId: string;
    fromAgent: string;
    message: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  // execution: main process relays a peer response back to the source worker
  | {
    type: "peer_response";
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
  // execution: local run result returned to main process
  | {
    type: "run_result";
    requestId: string;
    content: string;
    finishReason?: string;
  }
  // execution: local run error returned to main process
  | { type: "run_error"; requestId: string; code: string; message: string }
  // execution: source worker asks main process to route a peer request
  | {
    type: "peer_send";
    requestId: string;
    toAgent: string;
    message: string;
    traceId?: string;
    taskId?: string;
    contextId?: string;
  }
  // execution: target worker returns peer result to main process
  | {
    type: "peer_result";
    requestId: string;
    content: string;
    error?: boolean;
  }
  // execution: worker emits task-level observability to main process
  | {
    type: "task_observe";
    taskId: string;
    from: string;
    to: string;
    message: string;
    status: string;
    result?: string;
    traceId?: string;
    contextId?: string;
  };

export type WorkerRunRequest = Extract<WorkerRequest, { type: "run" }>;
export type WorkerPeerDeliverRequest = Extract<
  WorkerRequest,
  { type: "peer_deliver" }
>;
export type WorkerPeerResponseRequest = Extract<
  WorkerRequest,
  { type: "peer_response" }
>;
export type WorkerAskApprovalMessage = Extract<
  WorkerResponse,
  { type: "ask_approval" }
>;
export type WorkerPeerSendMessage = Extract<
  WorkerResponse,
  { type: "peer_send" }
>;
export type WorkerPeerResultMessage = Extract<
  WorkerResponse,
  { type: "peer_result" }
>;
export type WorkerTaskObserveMessage = Extract<
  WorkerResponse,
  { type: "task_observe" }
>;

// ── Classification helpers ───────────────────────────────

const INFRA_REQUEST_TYPES: ReadonlySet<InfraRequestType> = new Set([
  "init",
  "ask_response",
  "shutdown",
]);

const EXECUTION_REQUEST_TYPES: ReadonlySet<ExecutionRequestType> = new Set([
  "run",
  "peer_deliver",
  "peer_response",
]);

const INFRA_RESPONSE_TYPES: ReadonlySet<InfraResponseType> = new Set([
  "ready",
  "ask_approval",
  "task_started",
  "task_completed",
]);

const EXECUTION_RESPONSE_TYPES: ReadonlySet<ExecutionResponseType> = new Set([
  "run_result",
  "run_error",
  "peer_send",
  "peer_result",
  "task_observe",
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

/** Returns true if this request message type is execution plumbing. */
export function isExecutionRequest(type: WorkerRequest["type"]): boolean {
  return EXECUTION_REQUEST_TYPES.has(type as ExecutionRequestType);
}

/** Returns true if this response message type is execution plumbing. */
export function isExecutionResponse(type: WorkerResponse["type"]): boolean {
  return EXECUTION_RESPONSE_TYPES.has(type as ExecutionResponseType);
}
