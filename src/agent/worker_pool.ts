import type { AgentResponse } from "./types.ts";
import type {
  WorkerAskApprovalMessage,
  WorkerConfig,
  WorkerPeerResponseRequest,
  WorkerPeerSendMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerRunRequest,
  WorkerTaskObserveMessage,
} from "./worker_protocol.ts";
import { log } from "../shared/log.ts";
import {
  generateId,
  getAgentMemoryPath,
  getAgentRuntimeDir,
} from "../shared/helpers.ts";
import { ensureDir } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import type { AgentEntry, ApprovalReason } from "../shared/types.ts";

interface PendingRequest {
  resolve: (value: AgentResponse) => void;
  reject: (reason: Error) => void;
  timer: number;
}

interface AgentWorker {
  worker: Worker;
  agentId: string;
  ready: boolean;
}

export interface WorkerPoolCallbacks {
  onWorkerReady?: (agentId: string) => void;
  onWorkerStopped?: (agentId: string) => void;
  onAgentMessage?: (
    fromAgent: string,
    toAgent: string,
    message: string,
  ) => void;
  onAskApproval?: (
    agentId: string,
    requestId: string,
    command: string,
    binary: string,
    reason: ApprovalReason,
  ) => Promise<{ approved: boolean; allowAlways?: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 30_000;
const DATA_DIR = "./data";

/**
 * WorkerPool — spawns and manages one Worker per agent.
 * Communication uses postMessage (typed WorkerRequest/WorkerResponse protocol).
 */
interface AgentMessagePending {
  fromAgent: string;
  sourceRequestId: string;
  taskId?: string;
  contextId?: string;
  traceId?: string;
  timer: number;
}

export class WorkerPool {
  private config: WorkerConfig;
  private agents: Map<string, AgentWorker> = new Map();
  private pending: Map<string, PendingRequest> = new Map();
  private agentPending: Map<string, AgentMessagePending> = new Map();
  private entrypointUrl: string;
  private callbacks: WorkerPoolCallbacks;
  private sharedKv: Deno.Kv | null = null;

  constructor(config: WorkerConfig, callbacks?: WorkerPoolCallbacks) {
    this.config = config;
    this.callbacks = callbacks ?? {};
    this.entrypointUrl =
      new URL("./worker_entrypoint.ts", import.meta.url).href;
  }

  /** Inject shared KV for observability writes (task tracking, agent status). */
  setSharedKv(kv: Deno.Kv): void {
    this.sharedKv = kv;
  }

  async start(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) {
      log.warn(
        "WorkerPool: no agents configured — starting empty. Add agents via API or dashboard.",
      );
      return;
    }
    await Deno.mkdir(DATA_DIR, { recursive: true });
    // Ensure each agent's workspace dir exists (for memory.db)
    await Promise.all(agentIds.map((id) => ensureDir(getAgentRuntimeDir(id))));

    const readyPromises: Promise<void>[] = [];
    for (const agentId of agentIds) {
      readyPromises.push(this.spawnWorker(agentId));
    }

    await Promise.all(readyPromises);
    log.info(`WorkerPool started — ${this.agents.size} agent(s)`);
  }

  private spawnWorker(agentId: string): Promise<void> {
    const worker = new Worker(this.entrypointUrl, {
      type: "module",
      name: `agent-${agentId}`,
    });

    const entry: AgentWorker = { worker, agentId, ready: false };
    this.agents.set(agentId, entry);

    // Fix #1 + #5: use addEventListener (additive), reject on error, timeout on init
    return new Promise<void>((resolve, reject) => {
      const initTimer = setTimeout(() => {
        worker.terminate();
        this.agents.delete(agentId);
        reject(
          new AgentError(
            "WORKER_INIT_TIMEOUT",
            { agentId },
            `Worker ${agentId} failed to start within ${INIT_TIMEOUT_MS}ms`,
          ),
        );
      }, INIT_TIMEOUT_MS);

      const onReady = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.type === "ready") {
          clearTimeout(initTimer);
          entry.ready = true;
          worker.removeEventListener("message", onReady);
          // Switch to normal handler for subsequent messages
          worker.addEventListener(
            "message",
            (ev: MessageEvent<WorkerResponse>) => {
              this.handleWorkerMessage(agentId, ev.data);
            },
          );
          log.info(`Worker ${agentId} ready`);
          this.callbacks.onWorkerReady?.(agentId);
          resolve();
        }
      };

      worker.addEventListener("message", onReady);

      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(initTimer);
        log.error(`Worker ${agentId} error: ${e.message}`);
        e.preventDefault();
        if (!entry.ready) {
          worker.terminate();
          this.agents.delete(agentId);
          reject(
            new AgentError(
              "WORKER_INIT_FAILED",
              { agentId, error: e.message },
              "Check worker entrypoint for import errors",
            ),
          );
        }
      };

      const initMsg: WorkerRequest = {
        type: "init",
        agentId,
        config: this.config,
        kvPaths: {
          private: getAgentMemoryPath(agentId),
          shared: `${DATA_DIR}/shared.db`,
        },
      };
      worker.postMessage(initMsg);
    });
  }

  private handleWorkerMessage(fromAgentId: string, msg: WorkerResponse): void {
    switch (msg.type) {
      case "run_result": {
        const req = this.pending.get(msg.requestId);
        if (req) {
          clearTimeout(req.timer);
          this.pending.delete(msg.requestId);
          req.resolve({ content: msg.content, finishReason: msg.finishReason });
        }
        break;
      }

      case "run_error": {
        const req = this.pending.get(msg.requestId);
        if (req) {
          clearTimeout(req.timer);
          this.pending.delete(msg.requestId);
          req.reject(
            new AgentError(
              msg.code,
              { message: msg.message },
              "Check agent logs",
            ),
          );
        } else {
          log.error(`Uncorrelated worker error: [${msg.code}] ${msg.message}`);
        }
        break;
      }

      case "peer_send": {
        this.routeAgentMessage(fromAgentId, msg);
        break;
      }

      case "peer_result": {
        const pendingReq = this.agentPending.get(msg.requestId);
        if (pendingReq) {
          clearTimeout(pendingReq.timer);
          this.agentPending.delete(msg.requestId);
          const source = this.agents.get(pendingReq.fromAgent);
          if (source) {
            const response: WorkerPeerResponseRequest = {
              type: "peer_response",
              requestId: pendingReq.sourceRequestId,
              content: msg.content,
              error: msg.error,
            };
            source.worker.postMessage(response);
          }
        }
        break;
      }

      case "task_started": {
        this.writeActiveTask(
          fromAgentId,
          msg.taskId ?? msg.requestId,
          msg.sessionId,
          msg.traceId,
          msg.contextId,
        );
        break;
      }

      case "task_completed": {
        this.clearActiveTask(fromAgentId);
        break;
      }

      case "task_observe": {
        this.writeTaskObservation(msg);
        break;
      }

      case "ask_approval": {
        this.handleAskApproval(fromAgentId, msg).catch((e) => {
          log.error(
            `handleAskApproval failed for ${fromAgentId}: ${
              (e as Error).message
            }`,
          );
        });
        break;
      }

      case "ready": {
        break;
      }
    }
  }

  private async handleAskApproval(
    agentId: string,
    msg: WorkerAskApprovalMessage,
  ): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    let approved = false;
    let allowAlways = false;

    if (this.callbacks.onAskApproval) {
      try {
        const result = await this.callbacks.onAskApproval(
          agentId,
          msg.requestId,
          msg.command,
          msg.binary,
          msg.reason,
        );
        approved = result.approved;
        allowAlways = result.allowAlways ?? false;
      } catch {
        // Callback error = deny
        log.debug(`Ask approval callback failed for ${agentId}, denying`);
      }
    } else {
      log.warn(
        `No onAskApproval callback — denying command '${msg.binary}' for agent ${agentId}`,
      );
    }

    const response: WorkerRequest = {
      type: "ask_response",
      requestId: msg.requestId,
      approved,
      allowAlways,
    };
    entry.worker.postMessage(response);
  }

  // Fix #4: check ready flag before sending
  send(
    agentId: string,
    sessionId: string,
    message: string,
    options?: {
      model?: string;
      timeoutMs?: number;
      taskId?: string;
      contextId?: string;
      traceId?: string;
    },
  ): Promise<AgentResponse> {
    const entry = this.agents.get(agentId);
    if (!entry) {
      throw new AgentError("NO_WORKER", {
        agentId,
        available: this.getAgentIds(),
      }, "Use an agentId that exists in agents.registry");
    }
    if (!entry.ready) {
      throw new AgentError(
        "WORKER_NOT_READY",
        { agentId: entry.agentId },
        "Wait for WorkerPool.start() to complete",
      );
    }

    const requestId = generateId();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AgentError("WORKER_TIMEOUT", {
            agentId: entry.agentId,
            timeoutMs,
          }, "Increase timeout or check agent health"),
        );
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      const msg: WorkerRunRequest = {
        type: "run",
        requestId,
        sessionId,
        message,
        model: options?.model,
        traceId: options?.traceId,
        taskId: options?.taskId,
        contextId: options?.contextId,
      };
      entry.worker.postMessage(msg);
    });
  }

  shutdown(): void {
    // Terminate all workers directly
    for (const [agentId, entry] of this.agents) {
      try {
        entry.worker.terminate();
      } catch {
        log.debug(`Worker ${agentId} already terminated`);
      }
      this.callbacks.onWorkerStopped?.(agentId);
    }

    // Drain pending maps
    const snapshot = [...this.pending.entries()];
    this.pending.clear();
    for (const [_, req] of snapshot) {
      clearTimeout(req.timer);
      req.reject(
        new AgentError(
          "WORKER_POOL_SHUTDOWN",
          {},
          "WorkerPool is shutting down",
        ),
      );
    }

    for (const [_, pendingReq] of this.agentPending) {
      clearTimeout(pendingReq.timer);
    }
    this.agentPending.clear();

    this.agents.clear();
    log.info("WorkerPool stopped");
  }

  /** Add an agent dynamically (hot-add, no restart needed). */
  async addAgent(agentId: string, entry: AgentEntry): Promise<void> {
    if (this.agents.has(agentId)) {
      throw new AgentError(
        "AGENT_EXISTS",
        { agentId },
        "Agent already running",
      );
    }
    // Update config registry so the worker sees the agent config
    if (!this.config.agents.registry) this.config.agents.registry = {};
    this.config.agents.registry[agentId] = entry;

    await Deno.mkdir(DATA_DIR, { recursive: true });
    await ensureDir(getAgentRuntimeDir(agentId));
    await this.spawnWorker(agentId);
    log.info(`Agent hot-added: ${agentId}`);
  }

  /** Remove an agent dynamically. */
  removeAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    try {
      entry.worker.terminate();
    } catch { /* already dead */ }
    this.agents.delete(agentId);
    if (this.config.agents.registry) {
      delete this.config.agents.registry[agentId];
    }
    this.callbacks.onWorkerStopped?.(agentId);
    log.info(`Agent removed: ${agentId}`);
  }

  // ── Shared KV writes (observability, on behalf of Workers) ──

  private writeActiveTask(
    agentId: string,
    taskId: string,
    sessionId: string,
    traceId?: string,
    contextId?: string,
  ): void {
    if (!this.sharedKv) return;
    this.sharedKv.set(["agents", agentId, "active_task"], {
      taskId,
      sessionId,
      traceId,
      contextId,
      startedAt: new Date().toISOString(),
    }).catch(() => {/* best-effort */});
  }

  private clearActiveTask(agentId: string): void {
    if (!this.sharedKv) return;
    this.sharedKv.delete(["agents", agentId, "active_task"]).catch(
      () => {/* best-effort */},
    );
  }

  private writeTaskObservation(
    msg: WorkerTaskObserveMessage,
  ): void {
    if (!this.sharedKv) return;
    const task = { ...msg, timestamp: new Date().toISOString() };
    this.sharedKv.atomic()
      .set(["task_observations", msg.taskId], task)
      .set(["_dashboard", "task_observation_update"], task)
      .commit()
      .catch(() => {/* best-effort */});
  }

  // ── Agent Message Routing ───────────────────────────────

  private routeAgentMessage(
    fromAgent: string,
    msg: WorkerPeerSendMessage,
  ): void {
    // Peer check
    const registry = this.config.agents.registry;
    if (registry) {
      const sender = registry[fromAgent];
      const target = registry[msg.toAgent];

      // Closed by default (ADR-006): undefined/empty = deny all, must explicitly list peers
      const senderPeers = sender?.peers ?? [];
      if (!senderPeers.includes(msg.toAgent) && !senderPeers.includes("*")) {
        this.rejectAgentRequest(
          fromAgent,
          msg.requestId,
          "PEER_NOT_ALLOWED",
          `Agent "${fromAgent}" cannot send to "${msg.toAgent}" (not in peers)`,
        );
        return;
      }
      const targetAccept = target?.acceptFrom ?? [];
      if (!targetAccept.includes(fromAgent) && !targetAccept.includes("*")) {
        this.rejectAgentRequest(
          fromAgent,
          msg.requestId,
          "PEER_REJECTED",
          `Agent "${msg.toAgent}" does not accept from "${fromAgent}"`,
        );
        return;
      }
    }

    // Target worker exists?
    const targetEntry = this.agents.get(msg.toAgent);
    if (!targetEntry || !targetEntry.ready) {
      this.rejectAgentRequest(
        fromAgent,
        msg.requestId,
        "NO_WORKER",
        `Agent "${msg.toAgent}" not found or not ready`,
      );
      return;
    }

    // Callback for metrics/logging
    this.callbacks.onAgentMessage?.(fromAgent, msg.toAgent, msg.message);

    // Route to target Worker with timeout
    const deliverRequestId = generateId();
    const timer = setTimeout(() => {
      this.agentPending.delete(deliverRequestId);
      this.rejectAgentRequest(
        fromAgent,
        msg.requestId,
        "AGENT_MSG_TIMEOUT",
        `Agent "${msg.toAgent}" did not respond within 120s`,
      );
    }, DEFAULT_TIMEOUT_MS);
    this.agentPending.set(deliverRequestId, {
      fromAgent,
      sourceRequestId: msg.requestId,
      taskId: msg.taskId,
      contextId: msg.contextId,
      traceId: msg.traceId,
      timer,
    });

    const deliverMsg: WorkerRequest = {
      type: "peer_deliver",
      requestId: deliverRequestId,
      fromAgent,
      message: msg.message,
      traceId: msg.traceId,
      taskId: msg.taskId,
      contextId: msg.contextId,
    };
    targetEntry.worker.postMessage(deliverMsg);

    log.info(`Agent message: ${fromAgent} → ${msg.toAgent}`);
  }

  private rejectAgentRequest(
    fromAgent: string,
    sourceRequestId: string,
    code: string,
    message: string,
  ): void {
    const source = this.agents.get(fromAgent);
    if (source) {
      const response: WorkerRequest = {
        type: "peer_response",
        requestId: sourceRequestId,
        content: `[${code}] ${message}`,
        error: true,
      };
      source.worker.postMessage(response);
    }
  }

  getAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  isReady(agentId: string): boolean {
    return this.agents.get(agentId)?.ready ?? false;
  }
}
