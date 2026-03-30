import { assertEquals, assertRejects } from "@std/assert";
import type { AgentEntry } from "../shared/types.ts";
import type { WorkerResponse } from "./worker_protocol.ts";
import { WorkerPoolLifecycle } from "./worker_pool_lifecycle.ts";
import type { WorkerConfig } from "./worker_protocol.ts";
import type { WorkerPoolWorker } from "./worker_pool_types.ts";

class FakeWorker implements WorkerPoolWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  private listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(
    type: "message",
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: WorkerResponse): void {
    const event = new MessageEvent<WorkerResponse>("message", { data });
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") {
        listener(event);
        continue;
      }
      listener.handleEvent(event);
    }
  }
}

function createWorkerConfig(): WorkerConfig {
  return {
    agents: {
      defaults: {} as WorkerConfig["agents"]["defaults"],
      registry: {},
    },
    providers: {} as WorkerConfig["providers"],
    tools: {} as WorkerConfig["tools"],
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("WorkerPoolLifecycle starts workers and forwards runtime messages", async () => {
  const workers = new Map<string, FakeWorker>();
  const ready: string[] = [];
  const messages: Array<{ agentId: string; type: string }> = [];
  const lifecycle = new WorkerPoolLifecycle({
    config: createWorkerConfig(),
    entrypointUrl: "file:///worker_entrypoint.ts",
    callbacks: {
      onWorkerReady: (agentId) => ready.push(agentId),
    },
    onWorkerMessage: (agentId, msg) =>
      messages.push({ agentId, type: msg.type }),
    prepareSharedStorage: () => Promise.resolve(),
    prepareAgentStorage: () => Promise.resolve(),
    getKvPaths: () => ({
      private: "/tmp/agent-alpha-memory.db",
      shared: "/tmp/shared.db",
    }),
    workerFactory: (_url, agentId) => {
      const worker = new FakeWorker();
      workers.set(agentId, worker);
      return worker;
    },
  });

  const startPromise = lifecycle.start(["agent-alpha"]);
  await flushAsync();
  const worker = workers.get("agent-alpha");
  if (!worker) throw new Error("expected fake worker");

  assertEquals(worker.posted[0], {
    type: "init",
    agentId: "agent-alpha",
    config: createWorkerConfig(),
    kvPaths: {
      private: "/tmp/agent-alpha-memory.db",
      shared: "/tmp/shared.db",
    },
  });

  worker.emit({ type: "ready", agentId: "agent-alpha" });
  await startPromise;

  assertEquals(ready, ["agent-alpha"]);
  assertEquals(lifecycle.getAgentIds(), ["agent-alpha"]);
  assertEquals(lifecycle.isReady("agent-alpha"), true);

  worker.emit({
    type: "task_completed",
    requestId: "req-1",
  });
  assertEquals(messages, [{ agentId: "agent-alpha", type: "task_completed" }]);
});

Deno.test(
  "WorkerPoolLifecycle addAgent and removeAgent update the resolved runtime registry",
  async () => {
    const workers = new Map<string, FakeWorker>();
    const stopped: string[] = [];
    const config = createWorkerConfig();
    const lifecycle = new WorkerPoolLifecycle({
      config,
      entrypointUrl: "file:///worker_entrypoint.ts",
      callbacks: {
        onWorkerStopped: (agentId) => stopped.push(agentId),
      },
      onWorkerMessage: () => {},
      prepareSharedStorage: () => Promise.resolve(),
      prepareAgentStorage: () => Promise.resolve(),
      getKvPaths: (agentId) => ({
        private: `/tmp/${agentId}.db`,
        shared: "/tmp/shared.db",
      }),
      workerFactory: (_url, agentId) => {
        const worker = new FakeWorker();
        workers.set(agentId, worker);
        return worker;
      },
    });
    const agentEntry = { model: "gpt-5.4" } as AgentEntry;

    const pending = lifecycle.addAgent("agent-beta", agentEntry);
    await flushAsync();
    const worker = workers.get("agent-beta");
    if (!worker) throw new Error("expected fake worker");
    worker.emit({ type: "ready", agentId: "agent-beta" });
    await pending;

    assertEquals(config.agents.registry?.["agent-beta"], agentEntry);
    assertEquals(lifecycle.isReady("agent-beta"), true);

    assertEquals(lifecycle.removeAgent("agent-beta"), true);
    assertEquals(worker.terminated, true);
    assertEquals(config.agents.registry?.["agent-beta"], undefined);
    assertEquals(stopped, ["agent-beta"]);
  },
);

Deno.test("WorkerPoolLifecycle rejects init failures", async () => {
  const worker = new FakeWorker();
  const lifecycle = new WorkerPoolLifecycle({
    config: createWorkerConfig(),
    entrypointUrl: "file:///worker_entrypoint.ts",
    callbacks: {},
    onWorkerMessage: () => {},
    prepareSharedStorage: () => Promise.resolve(),
    prepareAgentStorage: () => Promise.resolve(),
    getKvPaths: (agentId) => ({
      private: `/tmp/${agentId}.db`,
      shared: "/tmp/shared.db",
    }),
    workerFactory: () => worker,
  });

  const pending = lifecycle.start(["agent-gamma"]);
  await flushAsync();
  worker.onerror?.(
    new ErrorEvent("error", { message: "import boom", cancelable: true }),
  );

  await assertRejects(
    () => pending,
    Error,
    "Check worker entrypoint for import errors",
  );
  assertEquals(lifecycle.getAgentIds(), []);
  assertEquals(worker.terminated, true);
});
