import { assertEquals, assertRejects } from "@std/assert";
import type { ApprovalRequest } from "./sandbox_types.ts";
import { WorkerApprovalBridge } from "./worker_runtime_approval.ts";

function createApprovalRequest(): ApprovalRequest {
  return {
    requestId: "approval-1",
    command: "git push origin main",
    binary: "git",
    reason: "not-in-allowlist",
  };
}

Deno.test("WorkerApprovalBridge emits ask_approval and resolves responses", async () => {
  const messages: unknown[] = [];
  const bridge = new WorkerApprovalBridge(
    (msg) => messages.push(msg),
    () => "agent-alpha",
    50,
  );

  const pending = bridge.askApproval(createApprovalRequest());

  assertEquals(messages, [{
    type: "ask_approval",
    requestId: "approval-1",
    agentId: "agent-alpha",
    command: "git push origin main",
    binary: "git",
    reason: "not-in-allowlist",
  }]);

  bridge.handleAskResponse({
    type: "ask_response",
    requestId: "approval-1",
    approved: true,
    allowAlways: true,
  });

  assertEquals(await pending, { approved: true, allowAlways: true });
});

Deno.test("WorkerApprovalBridge rejects pending approvals on shutdown", async () => {
  const bridge = new WorkerApprovalBridge(
    () => {},
    () => "agent-alpha",
    50,
  );

  const pending = bridge.askApproval(createApprovalRequest());
  bridge.shutdown();

  await assertRejects(
    () => pending,
    Error,
    "Worker is shutting down",
  );
});
