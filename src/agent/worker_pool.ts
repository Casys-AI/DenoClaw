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

const DEFAULT_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 30_000;
const DATA_DIR = "./data";

/**
 * WorkerPool — spawne et gère un Worker par agent.
 * Communication via postMessage (protocol typé WorkerRequest/WorkerResponse).
 */
export class WorkerPool {
  private config: WorkerConfig;
  private agents: Map<string, AgentWorker> = new Map();
  private pending: Map<string, PendingRequest> = new Map();
  private entrypointUrl: string;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.entrypointUrl = new URL("./worker_entrypoint.ts", import.meta.url).href;
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
          resolve();
        }
      };

      worker.addEventListener("message", onReady);

      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(initTimer);
        log.error(`Worker ${agentId} erreur: ${e.message}`);
        e.preventDefault();
        if (!entry.ready) {
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

  private handleWorkerMessage(_agentId: string, msg: WorkerResponse): void {
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
    }

    // Fix #3: drain pending map before iterating
    const snapshot = [...this.pending.entries()];
    this.pending.clear();
    for (const [_, req] of snapshot) {
      clearTimeout(req.timer);
      req.reject(new AgentError("WORKER_POOL_SHUTDOWN", {}, "WorkerPool is shutting down"));
    }

    this.agents.clear();
    log.info("WorkerPool arrêté");
  }

  getAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  isReady(agentId: string): boolean {
    return this.agents.get(agentId)?.ready ?? false;
  }
}
