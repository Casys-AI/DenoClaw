import type { AgentEntry } from "../shared/types.ts";
import {
  ensureDir,
  getAgentMemoryPath,
  getAgentRuntimeDir,
} from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import type { AgentRuntimeRegistry } from "./registry.ts";
import type {
  WorkerConfig,
  WorkerKvPaths,
  WorkerRequest,
  WorkerResponse,
} from "./worker_protocol.ts";
import type {
  AgentWorker,
  WorkerPoolCallbacks,
  WorkerPoolWorker,
} from "./worker_pool_types.ts";

const DATA_DIR = "./data";
const INIT_TIMEOUT_MS = 30_000;

export interface WorkerPoolLifecycleDeps {
  config: WorkerConfig;
  runtimeRegistry: AgentRuntimeRegistry;
  entrypointUrl: string;
  callbacks: WorkerPoolCallbacks;
  onWorkerMessage: (agentId: string, msg: WorkerResponse) => void;
  workerFactory?: (entrypointUrl: string, agentId: string) => WorkerPoolWorker;
  prepareSharedStorage?: () => Promise<void>;
  prepareAgentStorage?: (agentId: string) => Promise<void>;
  getKvPaths?: (agentId: string) => WorkerKvPaths;
}

export class WorkerPoolLifecycle {
  private agents = new Map<string, AgentWorker>();

  constructor(private readonly deps: WorkerPoolLifecycleDeps) {}

  getAgent(agentId: string): AgentWorker | undefined {
    return this.agents.get(agentId);
  }

  getAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  isReady(agentId: string): boolean {
    return this.agents.get(agentId)?.ready ?? false;
  }

  async start(agentIds: string[]): Promise<void> {
    await this.prepareSharedStorage();
    await Promise.all(agentIds.map((id) => this.prepareAgentStorage(id)));
    await Promise.all(agentIds.map((agentId) => this.spawnWorker(agentId)));
  }

  async addAgent(agentId: string, entry: AgentEntry): Promise<void> {
    if (this.agents.has(agentId)) {
      throw new AgentError(
        "AGENT_EXISTS",
        { agentId },
        "Agent already running",
      );
    }
    // Keep the resolved in-memory registry aligned for hot-added workers.
    // This is runtime-only state, not canonical persisted agent storage.
    this.deps.runtimeRegistry.set(agentId, entry);

    await this.prepareSharedStorage();
    await this.prepareAgentStorage(agentId);
    await this.spawnWorker(agentId);
  }

  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    try {
      entry.worker.terminate();
    } catch {
      log.debug(`Worker ${agentId} already terminated`);
    }
    this.agents.delete(agentId);
    if (this.deps.runtimeRegistry.has(agentId)) {
      // Remove from the in-memory resolved registry used by already-running
      // workers and peer routing.
      this.deps.runtimeRegistry.delete(agentId);
    }
    this.deps.callbacks.onWorkerStopped?.(agentId);
    return true;
  }

  shutdown(): void {
    for (const [agentId, entry] of this.agents) {
      try {
        entry.worker.terminate();
      } catch {
        log.debug(`Worker ${agentId} already terminated`);
      }
      this.deps.callbacks.onWorkerStopped?.(agentId);
    }
    this.agents.clear();
  }

  private spawnWorker(agentId: string): Promise<void> {
    const worker =
      this.deps.workerFactory?.(this.deps.entrypointUrl, agentId) ??
        new Worker(this.deps.entrypointUrl, {
          type: "module",
          name: `agent-${agentId}`,
        });

    const entry: AgentWorker = { worker, agentId, ready: false };
    this.agents.set(agentId, entry);

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

      const onReady: EventListener = (event) => {
        const message = (event as MessageEvent<WorkerResponse>).data;
        if (message.type !== "ready") return;
        clearTimeout(initTimer);
        entry.ready = true;
        worker.removeEventListener("message", onReady);
        worker.addEventListener(
          "message",
          ((nextEvent: Event) => {
            this.deps.onWorkerMessage(
              agentId,
              (nextEvent as MessageEvent<WorkerResponse>).data,
            );
          }) as EventListener,
        );
        log.info(`Worker ${agentId} ready`);
        this.deps.callbacks.onWorkerReady?.(agentId);
        resolve();
      };

      worker.addEventListener("message", onReady);
      worker.onerror = (event: ErrorEvent) => {
        clearTimeout(initTimer);
        log.error(`Worker ${agentId} error: ${event.message}`);
        event.preventDefault();
        if (entry.ready) return;
        worker.terminate();
        this.agents.delete(agentId);
        reject(
          new AgentError(
            "WORKER_INIT_FAILED",
            { agentId, error: event.message },
            "Check worker entrypoint for import errors",
          ),
        );
      };

      const initMsg: WorkerRequest = {
        type: "init",
        agentId,
        config: this.deps.config,
        agentRegistry: this.deps.runtimeRegistry.snapshot(),
        kvPaths: this.getKvPaths(agentId),
      };
      worker.postMessage(initMsg);
    });
  }

  private prepareSharedStorage(): Promise<void> {
    if (this.deps.prepareSharedStorage) {
      return this.deps.prepareSharedStorage();
    }
    return Deno.mkdir(DATA_DIR, { recursive: true });
  }

  private prepareAgentStorage(agentId: string): Promise<void> {
    if (this.deps.prepareAgentStorage) {
      return this.deps.prepareAgentStorage(agentId);
    }
    return ensureDir(getAgentRuntimeDir(agentId));
  }

  private getKvPaths(agentId: string): WorkerKvPaths {
    if (this.deps.getKvPaths) {
      return this.deps.getKvPaths(agentId);
    }
    return {
      private: getAgentMemoryPath(agentId),
      shared: `${DATA_DIR}/shared.db`,
    };
  }
}
