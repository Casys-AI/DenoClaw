import { assertEquals } from "@std/assert";
import { WorkerPoolApprovalBridge } from "./worker_pool_approval.ts";
import type { AgentWorker, WorkerPoolWorker } from "./worker_pool_types.ts";

class FakeWorker implements WorkerPoolWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];

  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
}

function createAgentWorker(worker = new FakeWorker()): {
  entry: AgentWorker;
  worker: FakeWorker;
} {
  return {
    entry: {
      worker,
      agentId: "agent-alpha",
      ready: true,
    },
    worker,
  };
}

Deno.test("WorkerPoolApprovalBridge posts approved responses", async () => {
  const { entry, worker } = createAgentWorker();
  const bridge = new WorkerPoolApprovalBridge({
    getAgent: () => entry,
    onAskApproval: () =>
      Promise.resolve({
        approved: true,
        allowAlways: true,
      }),
  });

  await bridge.handleAskApproval("agent-alpha", {
    type: "ask_approval",
    requestId: "approval-1",
    agentId: "agent-alpha",
    command: "git push",
    binary: "git",
    reason: "not-in-allowlist",
  });

  assertEquals(worker.posted, [{
    type: "ask_response",
    requestId: "approval-1",
    approved: true,
    allowAlways: true,
  }]);
});

Deno.test("WorkerPoolApprovalBridge denies when callback throws", async () => {
  const { entry, worker } = createAgentWorker();
  const bridge = new WorkerPoolApprovalBridge({
    getAgent: () => entry,
    onAskApproval: () => Promise.reject(new Error("boom")),
  });

  await bridge.handleAskApproval("agent-alpha", {
    type: "ask_approval",
    requestId: "approval-2",
    agentId: "agent-alpha",
    command: "rm -rf /",
    binary: "rm",
    reason: "not-in-allowlist",
  });

  assertEquals(worker.posted, [{
    type: "ask_response",
    requestId: "approval-2",
    approved: false,
    allowAlways: false,
  }]);
});
