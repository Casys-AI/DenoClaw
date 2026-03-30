import type { AgentResponse } from "./types.ts";
import type {
  WorkerConfig,
  WorkerResponse,
  WorkerRunRequest,
} from "./worker_protocol.ts";
import { log } from "../shared/log.ts";
import { generateId } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import type { AgentEntry } from "../shared/types.ts";
import { WorkerPoolObservability } from "./worker_pool_observability.ts";
import { WorkerPoolRequestTracker } from "./worker_pool_request_tracker.ts";
import { WorkerPoolPeerRouter } from "./worker_pool_peer_router.ts";
import { WorkerPoolLifecycle } from "./worker_pool_lifecycle.ts";
import { WorkerPoolApprovalBridge } from "./worker_pool_approval.ts";
import { AgentRuntimeRegistry, getResolvedAgentRegistry } from "./registry.ts";
import type { WorkerPeerSendMessage } from "./worker_protocol.ts";
import type { WorkerPoolCallbacks } from "./worker_pool_types.ts";
export type { WorkerPoolCallbacks } from "./worker_pool_types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * WorkerPool — spawns and manages one Worker per agent.
 * Communication uses postMessage (typed WorkerRequest/WorkerResponse protocol).
 */
export class WorkerPool {
  private readonly callbacks: WorkerPoolCallbacks;
  private readonly observability = new WorkerPoolObservability();
  private readonly requestTracker = new WorkerPoolRequestTracker();
  private readonly runtimeRegistry: AgentRuntimeRegistry;
  private readonly lifecycle: WorkerPoolLifecycle;
  private readonly approvalBridge: WorkerPoolApprovalBridge;
  private peerRouter: WorkerPoolPeerRouter;

  constructor(
    private readonly config: WorkerConfig,
    callbacks?: WorkerPoolCallbacks,
  ) {
    this.callbacks = callbacks ?? {};
    this.runtimeRegistry = new AgentRuntimeRegistry(
      getResolvedAgentRegistry(this.config),
    );
    this.lifecycle = new WorkerPoolLifecycle({
      config: this.config,
      runtimeRegistry: this.runtimeRegistry,
      callbacks: this.callbacks,
      entrypointUrl: new URL("./worker_entrypoint.ts", import.meta.url).href,
      onWorkerMessage: (agentId, msg) => this.handleWorkerMessage(agentId, msg),
    });
    this.approvalBridge = new WorkerPoolApprovalBridge({
      getAgent: (agentId) => this.lifecycle.getAgent(agentId),
      onAskApproval: this.callbacks.onAskApproval,
    });
    this.peerRouter = new WorkerPoolPeerRouter({
      runtimeRegistry: this.runtimeRegistry,
      getAgent: (agentId) => this.lifecycle.getAgent(agentId),
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
    await this.lifecycle.start(agentIds);
    log.info(
      `WorkerPool started — ${this.lifecycle.getAgentIds().length} agent(s)`,
    );
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
        this.approvalBridge.handleAskApproval(fromAgentId, msg).catch((e) => {
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
    const entry = this.lifecycle.getAgent(agentId);
    if (!entry) {
      throw new AgentError("NO_WORKER", {
        agentId,
        available: this.getAgentIds(),
      }, "Use an agentId that exists in the resolved agent registry");
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
    this.lifecycle.shutdown();
    this.requestTracker.shutdown();
    this.peerRouter.shutdown();
    log.info("WorkerPool stopped");
  }

  /** Add an agent dynamically (hot-add, no restart needed). */
  async addAgent(agentId: string, entry: AgentEntry): Promise<void> {
    await this.lifecycle.addAgent(agentId, entry);
    log.info(`Agent hot-added: ${agentId}`);
  }

  /** Remove an agent dynamically. */
  removeAgent(agentId: string): void {
    if (!this.lifecycle.removeAgent(agentId)) return;
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
    return this.lifecycle.getAgentIds();
  }

  isReady(agentId: string): boolean {
    return this.lifecycle.isReady(agentId);
  }
}
