import type { AgentResponse } from "./types.ts";
import type {
  WorkerAskApprovalMessage,
  WorkerConfig,
  WorkerPeerSendMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerRunRequest,
} from "./worker_protocol.ts";
import { log } from "../shared/log.ts";
import {
  generateId,
  getAgentMemoryPath,
  getAgentRuntimeDir,
} from "../shared/helpers.ts";
import { ensureDir } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import type { AgentEntry } from "../shared/types.ts";
import type { ApprovalReason } from "./sandbox_types.ts";
import { WorkerPoolObservability } from "./worker_pool_observability.ts";
import { WorkerPoolRequestTracker } from "./worker_pool_request_tracker.ts";
import { WorkerPoolPeerRouter } from "./worker_pool_peer_router.ts";

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
export class WorkerPool {
  private config: WorkerConfig;
  private agents: Map<string, AgentWorker> = new Map();
  private entrypointUrl: string;
  private callbacks: WorkerPoolCallbacks;
  private observability = new WorkerPoolObservability();
  private requestTracker = new WorkerPoolRequestTracker();
  private peerRouter: WorkerPoolPeerRouter;

  constructor(config: WorkerConfig, callbacks?: WorkerPoolCallbacks) {
    this.config = config;
    this.callbacks = callbacks ?? {};
    this.entrypointUrl =
      new URL("./worker_entrypoint.ts", import.meta.url).href;
    this.peerRouter = new WorkerPoolPeerRouter({
      config: this.config,
      getAgent: (agentId) => this.agents.get(agentId),
      onAgentMessage: this.callbacks.onAgentMessage,
    });
  }

  /** Inject shared KV for observability writes (task tracking, agent status). */
  setSharedKv(kv: Deno.Kv): void {
    this.observability.setSharedKv(kv);
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
        this.requestTracker.resolveRunResult(msg);
        break;
      }

      case "run_error": {
        if (!this.requestTracker.rejectRunError(msg)) {
          log.error(`Uncorrelated worker error: [${msg.code}] ${msg.message}`);
        }
        break;
      }

      case "peer_send": {
        this.routeAgentMessage(fromAgentId, msg);
        break;
      }

      case "peer_result": {
        this.peerRouter.handlePeerResult(msg);
        break;
      }

      case "task_started": {
        this.observability.writeActiveTask(
          fromAgentId,
          msg.taskId ?? msg.requestId,
          msg.sessionId,
          msg.traceId,
          msg.contextId,
        );
        break;
      }

      case "task_completed": {
        this.observability.clearActiveTask(fromAgentId);
        break;
      }

      case "task_observe": {
        this.observability.writeTaskObservation(msg);
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
    const responsePromise = this.requestTracker.createRunRequest(
      requestId,
      entry.agentId,
      timeoutMs,
    );

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
    return responsePromise;
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
    this.requestTracker.shutdown();
    this.peerRouter.shutdown();

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

  // ── Agent Message Routing ───────────────────────────────

  private routeAgentMessage(
    fromAgent: string,
    msg: WorkerPeerSendMessage,
  ): void {
    this.peerRouter.routeAgentMessage(fromAgent, msg);
  }

  getAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  isReady(agentId: string): boolean {
    return this.agents.get(agentId)?.ready ?? false;
  }
}
