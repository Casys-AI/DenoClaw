import type { AgentResponse } from "./types.ts";
import type { WorkerConfig, WorkerRequest, WorkerResponse } from "./worker_protocol.ts";
import { log } from "../shared/log.ts";
import { generateId } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";

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
  onAgentMessage?: (fromAgent: string, toAgent: string, message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 30_000;
const DATA_DIR = "./data";

/**
 * WorkerPool — spawne et gère un Worker par agent.
 * Communication via postMessage (protocol typé WorkerRequest/WorkerResponse).
 */
interface AgentMessagePending {
  fromAgent: string;
  sourceRequestId: string;
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
    this.entrypointUrl = new URL("./worker_entrypoint.ts", import.meta.url).href;
  }

  /** Inject shared KV for observability writes (task tracking, agent status). */
  setSharedKv(kv: Deno.Kv): void {
    this.sharedKv = kv;
  }

  async start(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) {
      throw new AgentError("NO_AGENTS", {}, "Add agents to config.agents.registry first");
    }
    await Deno.mkdir(DATA_DIR, { recursive: true });

    const readyPromises: Promise<void>[] = [];
    for (const agentId of agentIds) {
      readyPromises.push(this.spawnWorker(agentId));
    }

    await Promise.all(readyPromises);
    log.info(`WorkerPool démarré — ${this.agents.size} agent(s)`);
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
        reject(new AgentError("WORKER_INIT_TIMEOUT", { agentId }, `Worker ${agentId} failed to start within ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);

      const onReady = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.type === "ready") {
          clearTimeout(initTimer);
          entry.ready = true;
          worker.removeEventListener("message", onReady);
          // Switch to normal handler for subsequent messages
          worker.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
            this.handleWorkerMessage(agentId, ev.data);
          });
          log.info(`Worker ${agentId} prêt`);
          this.callbacks.onWorkerReady?.(agentId);
          resolve();
        }
      };

      worker.addEventListener("message", onReady);

      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(initTimer);
        log.error(`Worker ${agentId} erreur: ${e.message}`);
        e.preventDefault();
        if (!entry.ready) {
          worker.terminate();
          this.agents.delete(agentId);
          reject(new AgentError("WORKER_INIT_FAILED", { agentId, error: e.message }, "Check worker entrypoint for import errors"));
        }
      };

      const initMsg: WorkerRequest = {
        type: "init",
        agentId,
        config: this.config,
        kvPaths: {
          private: `${DATA_DIR}/${agentId}.db`,
          shared: `${DATA_DIR}/shared.db`,
        },
      };
      worker.postMessage(initMsg);
    });
  }

  private handleWorkerMessage(fromAgentId: string, msg: WorkerResponse): void {
    switch (msg.type) {
      case "result": {
        const req = this.pending.get(msg.requestId);
        if (req) {
          clearTimeout(req.timer);
          this.pending.delete(msg.requestId);
          req.resolve({ content: msg.content, finishReason: msg.finishReason });
        }
        break;
      }

      case "error": {
        const req = this.pending.get(msg.requestId);
        if (req) {
          clearTimeout(req.timer);
          this.pending.delete(msg.requestId);
          req.reject(new AgentError(msg.code, { message: msg.message }, "Check agent logs"));
        } else {
          log.error(`Worker erreur non corrélée: [${msg.code}] ${msg.message}`);
        }
        break;
      }

      case "agent_send": {
        this.routeAgentMessage(fromAgentId, msg.toAgent, msg.message, msg.requestId);
        break;
      }

      case "agent_result": {
        const pendingReq = this.agentPending.get(msg.requestId);
        if (pendingReq) {
          clearTimeout(pendingReq.timer);
          this.agentPending.delete(msg.requestId);
          const source = this.agents.get(pendingReq.fromAgent);
          if (source) {
            const response: WorkerRequest = {
              type: "agent_response",
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
        this.writeActiveTask(fromAgentId, msg.requestId, msg.sessionId, msg.traceId);
        break;
      }

      case "task_completed": {
        this.clearActiveTask(fromAgentId);
        break;
      }

      case "agent_task": {
        this.writeAgentTask(msg);
        break;
      }

      case "ready": {
        break;
      }
    }
  }

  // Fix #4: check ready flag before sending
  send(
    agentId: string,
    sessionId: string,
    message: string,
    options?: { model?: string; timeoutMs?: number },
  ): Promise<AgentResponse> {
    const entry = this.agents.get(agentId);
    if (!entry) {
      throw new AgentError("NO_WORKER", { agentId, available: this.getAgentIds() }, "Use an agentId that exists in agents.registry");
    }
    if (!entry.ready) {
      throw new AgentError("WORKER_NOT_READY", { agentId: entry.agentId }, "Wait for WorkerPool.start() to complete");
    }

    const requestId = generateId();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AgentError("WORKER_TIMEOUT", { agentId: entry.agentId, timeoutMs }, "Increase timeout or check agent health"));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      const msg: WorkerRequest = {
        type: "process",
        requestId,
        sessionId,
        message,
        model: options?.model,
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
        log.debug(`Worker ${agentId} déjà terminé`);
      }
      this.callbacks.onWorkerStopped?.(agentId);
    }

    // Drain pending maps
    const snapshot = [...this.pending.entries()];
    this.pending.clear();
    for (const [_, req] of snapshot) {
      clearTimeout(req.timer);
      req.reject(new AgentError("WORKER_POOL_SHUTDOWN", {}, "WorkerPool is shutting down"));
    }

    for (const [_, pendingReq] of this.agentPending) {
      clearTimeout(pendingReq.timer);
    }
    this.agentPending.clear();

    this.agents.clear();
    log.info("WorkerPool arrêté");
  }

  // ── Shared KV writes (observability, on behalf of Workers) ──

  private writeActiveTask(agentId: string, taskId: string, sessionId: string, traceId?: string): void {
    if (!this.sharedKv) return;
    this.sharedKv.set(["agents", agentId, "active_task"], {
      taskId, sessionId, traceId, startedAt: new Date().toISOString(),
    }).catch(() => { /* best-effort */ });
  }

  private clearActiveTask(agentId: string): void {
    if (!this.sharedKv) return;
    this.sharedKv.delete(["agents", agentId, "active_task"]).catch(() => { /* best-effort */ });
  }

  private writeAgentTask(msg: { taskId: string; from: string; to: string; message: string; status: string; result?: string; traceId?: string }): void {
    if (!this.sharedKv) return;
    const task = { ...msg, timestamp: new Date().toISOString() };
    this.sharedKv.atomic()
      .set(["agent_tasks", msg.taskId], task)
      .set(["_dashboard", "agent_task_update"], task)
      .commit()
      .catch(() => { /* best-effort */ });
  }

  // ── Agent Message Routing ───────────────────────────────

  private routeAgentMessage(fromAgent: string, toAgent: string, message: string, sourceRequestId: string): void {
    // Peer check
    const registry = this.config.agents.registry;
    if (registry) {
      const sender = registry[fromAgent];
      const target = registry[toAgent];

      // Closed by default (ADR-006): undefined/empty = deny all, must explicitly list peers
      const senderPeers = sender?.peers ?? [];
      if (!senderPeers.includes(toAgent) && !senderPeers.includes("*")) {
        this.rejectAgentRequest(fromAgent, sourceRequestId, "PEER_NOT_ALLOWED", `Agent "${fromAgent}" cannot send to "${toAgent}" (not in peers)`);
        return;
      }
      const targetAccept = target?.acceptFrom ?? [];
      if (!targetAccept.includes(fromAgent) && !targetAccept.includes("*")) {
        this.rejectAgentRequest(fromAgent, sourceRequestId, "PEER_REJECTED", `Agent "${toAgent}" does not accept from "${fromAgent}"`);
        return;
      }
    }

    // Target worker exists?
    const targetEntry = this.agents.get(toAgent);
    if (!targetEntry || !targetEntry.ready) {
      this.rejectAgentRequest(fromAgent, sourceRequestId, "NO_WORKER", `Agent "${toAgent}" not found or not ready`);
      return;
    }

    // Callback for metrics/logging
    this.callbacks.onAgentMessage?.(fromAgent, toAgent, message);

    // Route to target Worker with timeout
    const deliverRequestId = generateId();
    const timer = setTimeout(() => {
      this.agentPending.delete(deliverRequestId);
      this.rejectAgentRequest(fromAgent, sourceRequestId, "AGENT_MSG_TIMEOUT", `Agent "${toAgent}" did not respond within 120s`);
    }, DEFAULT_TIMEOUT_MS);
    this.agentPending.set(deliverRequestId, { fromAgent, sourceRequestId, timer });

    const deliverMsg: WorkerRequest = {
      type: "agent_deliver",
      requestId: deliverRequestId,
      fromAgent,
      message,
    };
    targetEntry.worker.postMessage(deliverMsg);

    log.info(`Agent message: ${fromAgent} → ${toAgent}`);
  }

  private rejectAgentRequest(fromAgent: string, sourceRequestId: string, code: string, message: string): void {
    const source = this.agents.get(fromAgent);
    if (source) {
      const response: WorkerRequest = {
        type: "agent_response",
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
