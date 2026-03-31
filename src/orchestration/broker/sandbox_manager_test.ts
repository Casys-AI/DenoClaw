import { assertEquals } from "@std/assert";
import type { SandboxBackend, SandboxConfig } from "../../shared/types.ts";
import type { ExecuteToolRequest } from "../tool_execution_port.ts";
import { BrokerSandboxManager } from "./sandbox_manager.ts";

function toolRequest(
  agentId: string,
  overrides: Partial<ExecuteToolRequest> = {},
): ExecuteToolRequest {
  return {
    tool: "shell",
    args: { command: "echo hi", dry_run: false },
    permissions: ["run"],
    networkAllow: ["example.com"],
    timeoutSec: 30,
    execPolicy: {
      security: "allowlist",
      allowedCommands: ["echo"],
    },
    executionContext: {
      agentId,
      ownershipScope: "agent",
    },
    ...overrides,
  };
}

class FakeSandboxBackend implements SandboxBackend {
  readonly kind = "cloud" as const;
  closeCalls = 0;
  executeCalls = 0;

  constructor(readonly id: string) {}

  execute() {
    this.executeCalls++;
    return Promise.resolve({ success: true, output: this.id });
  }

  close() {
    this.closeCalls++;
    return Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}

Deno.test("BrokerSandboxManager reuses the same sandbox for the same agent", async () => {
  const created: FakeSandboxBackend[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = await manager.executeTool(toolRequest("bob"));
  const second = await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      ownershipScope: "agent",
      taskId: "task-2",
    },
  }));

  assertEquals(first.output, "sandbox-1");
  assertEquals(second.output, "sandbox-1");
  assertEquals(created.length, 1);
  assertEquals(created[0].executeCalls, 2);

  await manager.close();
});

Deno.test("BrokerSandboxManager does not reuse sandboxes across agents", async () => {
  const created: FakeSandboxBackend[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  await manager.executeTool(toolRequest("alice"));
  await manager.executeTool(toolRequest("bob"));

  assertEquals(created.length, 2);
  assertEquals(created[0].executeCalls, 1);
  assertEquals(created[1].executeCalls, 1);

  await manager.close();
});

Deno.test("BrokerSandboxManager reuses the same sandbox for the same agent context", async () => {
  const created: FakeSandboxBackend[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-1",
      ownershipScope: "context",
    },
  }));
  const second = await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-1",
      ownershipScope: "context",
      taskId: "task-2",
    },
  }));

  assertEquals(first.output, "sandbox-1");
  assertEquals(second.output, "sandbox-1");
  assertEquals(created.length, 1);
  assertEquals(created[0].executeCalls, 2);

  await manager.close();
});

Deno.test("BrokerSandboxManager does not reuse sandboxes across contexts for the same agent", async () => {
  const created: FakeSandboxBackend[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-1",
      ownershipScope: "context",
    },
  }));
  await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-2",
      ownershipScope: "context",
    },
  }));

  assertEquals(created.length, 2);
  assertEquals(created[0].executeCalls, 1);
  assertEquals(created[1].executeCalls, 1);

  await manager.close();
});

Deno.test("BrokerSandboxManager recycles a sandbox when the network policy changes", async () => {
  const created: FakeSandboxBackend[] = [];
  const configs: SandboxConfig[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: (config) => {
      configs.push(config);
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  await manager.executeTool(
    toolRequest("bob", { networkAllow: ["a.example"] }),
  );
  await manager.executeTool(
    toolRequest("bob", { networkAllow: ["b.example"] }),
  );

  assertEquals(created.length, 2);
  assertEquals(created[0].closeCalls, 1);
  assertEquals(configs[0].networkAllow, ["a.example"]);
  assertEquals(configs[1].networkAllow, ["b.example"]);

  await manager.close();
});

Deno.test("BrokerSandboxManager attaches truthful owner labels", async () => {
  const labelSets: Record<string, string>[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: (_config, _context, labels) => {
      labelSets.push(labels);
      return new FakeSandboxBackend("sandbox-1");
    },
  });

  await manager.executeTool(toolRequest("bob"));

  assertEquals(labelSets, [{
    app: "denoclaw",
    runtime: "broker",
    backend: "cloud",
    owner_scope: "agent",
    owner_id: "bob",
  }]);

  await manager.close();
});

Deno.test("BrokerSandboxManager attaches context ownership labels when context-scoped", async () => {
  const labelSets: Record<string, string>[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: (_config, _context, labels) => {
      labelSets.push(labels);
      return new FakeSandboxBackend("sandbox-1");
    },
  });

  await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-1",
      ownershipScope: "context",
    },
  }));

  assertEquals(labelSets, [{
    app: "denoclaw",
    runtime: "broker",
    backend: "cloud",
    owner_scope: "context",
    owner_id: "bob:ctx-1",
  }]);

  await manager.close();
});

Deno.test("BrokerSandboxManager evicts idle sandboxes", async () => {
  let now = 0;
  const created: FakeSandboxBackend[] = [];
  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
    idleTimeoutMs: 1000,
    now: () => now,
  });

  await manager.executeTool(toolRequest("bob"));
  now = 2000;
  await manager.executeTool(toolRequest("alice"));

  assertEquals(created.length, 2);
  assertEquals(created[0].closeCalls, 1);
  assertEquals(created[1].closeCalls, 0);

  await manager.close();
});

Deno.test("BrokerSandboxManager refuses to exceed maxSandboxesPerBroker", async () => {
  const created: FakeSandboxBackend[] = [];
  const manager = new BrokerSandboxManager({
    maxSandboxes: 1,
    createBackend: () => {
      const backend = new FakeSandboxBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = await manager.executeTool(toolRequest("bob"));
  const second = await manager.executeTool(toolRequest("alice"));

  assertEquals(first.success, true);
  assertEquals(second.success, false);
  assertEquals(second.error?.code, "SANDBOX_CAPACITY_REACHED");
  assertEquals(second.error?.context, {
    ownerKey: "agent:alice",
    activeSandboxes: 1,
    maxSandboxesPerBroker: 1,
  });
  assertEquals(created.length, 1);

  await manager.close();
});

Deno.test("BrokerSandboxManager serializes same-agent executions on one sandbox", async () => {
  const firstExecution = createDeferred<{ success: true; output: string }>();
  const created: FakeSandboxBackend[] = [];

  class BlockingBackend extends FakeSandboxBackend {
    override execute() {
      this.executeCalls++;
      if (this.executeCalls === 1) return firstExecution.promise;
      return Promise.resolve({ success: true, output: this.id });
    }
  }

  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new BlockingBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = manager.executeTool(toolRequest("bob"));
  await waitFor(() => created.length === 1 && created[0].executeCalls === 1);
  const second = manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      ownershipScope: "agent",
      taskId: "task-2",
    },
  }));

  assertEquals(created.length, 1);
  assertEquals(created[0].executeCalls, 1);

  firstExecution.resolve({ success: true, output: "sandbox-1" });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEquals(firstResult.output, "sandbox-1");
  assertEquals(secondResult.output, "sandbox-1");
  assertEquals(created[0].executeCalls, 2);

  await manager.close();
});

Deno.test("BrokerSandboxManager allows same-agent executions to proceed in parallel across contexts", async () => {
  const firstExecution = createDeferred<{ success: true; output: string }>();
  const created: FakeSandboxBackend[] = [];

  class BlockingBackend extends FakeSandboxBackend {
    override execute() {
      this.executeCalls++;
      if (this.id === "sandbox-1") return firstExecution.promise;
      return Promise.resolve({ success: true, output: this.id });
    }
  }

  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new BlockingBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-1",
      ownershipScope: "context",
    },
  }));
  await waitFor(() => created.length === 1 && created[0].executeCalls === 1);

  const second = await manager.executeTool(toolRequest("bob", {
    executionContext: {
      agentId: "bob",
      contextId: "ctx-2",
      ownershipScope: "context",
      taskId: "task-2",
    },
  }));

  assertEquals(second.output, "sandbox-2");
  assertEquals(created.length, 2);
  assertEquals(created[1].executeCalls, 1);

  firstExecution.resolve({ success: true, output: "sandbox-1" });
  const firstResult = await first;
  assertEquals(firstResult.output, "sandbox-1");

  await manager.close();
});

Deno.test("BrokerSandboxManager does not evict an active sandbox", async () => {
  let now = 0;
  const firstExecution = createDeferred<{ success: true; output: string }>();
  const created: FakeSandboxBackend[] = [];

  class BlockingBackend extends FakeSandboxBackend {
    override execute() {
      this.executeCalls++;
      if (this.id === "sandbox-1") return firstExecution.promise;
      return Promise.resolve({ success: true, output: this.id });
    }
  }

  const manager = new BrokerSandboxManager({
    idleTimeoutMs: 1000,
    now: () => now,
    createBackend: () => {
      const backend = new BlockingBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = manager.executeTool(toolRequest("bob"));
  await Promise.resolve();
  now = 2000;

  const second = await manager.executeTool(toolRequest("alice"));

  assertEquals(second.output, "sandbox-2");
  assertEquals(created.length, 2);
  assertEquals(created[0].closeCalls, 0);

  firstExecution.resolve({ success: true, output: "sandbox-1" });
  const firstResult = await first;
  assertEquals(firstResult.output, "sandbox-1");

  await manager.close();
});

Deno.test("BrokerSandboxManager waits for release before recycling on policy change", async () => {
  const firstExecution = createDeferred<{ success: true; output: string }>();
  const created: FakeSandboxBackend[] = [];

  class BlockingBackend extends FakeSandboxBackend {
    override execute() {
      this.executeCalls++;
      if (this.id === "sandbox-1") return firstExecution.promise;
      return Promise.resolve({ success: true, output: this.id });
    }
  }

  const manager = new BrokerSandboxManager({
    createBackend: () => {
      const backend = new BlockingBackend(`sandbox-${created.length + 1}`);
      created.push(backend);
      return backend;
    },
  });

  const first = manager.executeTool(toolRequest("bob", {
    networkAllow: ["a.example"],
  }));
  await waitFor(() => created.length === 1 && created[0].executeCalls === 1);
  const second = manager.executeTool(toolRequest("bob", {
    networkAllow: ["b.example"],
    executionContext: {
      agentId: "bob",
      ownershipScope: "agent",
      taskId: "task-2",
    },
  }));

  assertEquals(created.length, 1);
  assertEquals(created[0].closeCalls, 0);

  firstExecution.resolve({ success: true, output: "sandbox-1" });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEquals(firstResult.output, "sandbox-1");
  assertEquals(secondResult.output, "sandbox-2");
  assertEquals(created.length, 2);
  assertEquals(created[0].closeCalls, 1);

  await manager.close();
});
