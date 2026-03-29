import { assertEquals } from "@std/assert";
import { AgentError } from "../shared/errors.ts";
import {
  type CanonicalWorkerTaskRequest,
  executeCanonicalWorkerTask,
} from "./worker_entrypoint.ts";
import type { AgentLoopFactoryContext, AgentLoopLike } from "./loop.ts";
import type { AgentResponse } from "./types.ts";
import type { Task } from "../messaging/a2a/types.ts";
import type { ApprovalRequest } from "../shared/mod.ts";

// ── Stubs ────────────────────────────────────────────────

class StubLoop implements AgentLoopLike {
  constructor(
    private readonly responder: (message: string) => Promise<AgentResponse>,
  ) {}

  processMessage(message: string): Promise<AgentResponse> {
    return this.responder(message);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function createRequest(
  overrides: Partial<CanonicalWorkerTaskRequest> = {},
): CanonicalWorkerTaskRequest {
  return {
    type: "run",
    requestId: "req-1",
    sessionId: "session-1",
    message: "hello",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

Deno.test("executeCanonicalWorkerTask maps local work into canonical A2A lifecycle while preserving caller output", async () => {
  const updates: string[] = [];

  const result = await executeCanonicalWorkerTask(createRequest(), {
    createLoop: () =>
      new StubLoop(() =>
        Promise.resolve({ content: "done", finishReason: "stop" })
      ),
    onTaskUpdate: (task: Task) => {
      updates.push(task.status.state);
    },
  });

  assertEquals(updates, ["SUBMITTED", "WORKING", "COMPLETED"]);
  assertEquals(result.task.id, "req-1");
  assertEquals(result.task.contextId, "session-1");
  assertEquals(result.task.artifacts[0].parts[0], {
    kind: "text",
    text: "done",
  });
  assertEquals(result.response, { content: "done", finishReason: "stop" });
});

Deno.test("executeCanonicalWorkerTask surfaces approval pauses as INPUT_REQUIRED then resumes WORKING", async () => {
  const updates: string[] = [];
  const approvals: ApprovalRequest[] = [];

  const result = await executeCanonicalWorkerTask(
    createRequest({ message: "git push" }),
    {
      createLoop: (ctx: AgentLoopFactoryContext) =>
        new StubLoop(async () => {
          const approval = await ctx.askApproval!({
            requestId: "approval-1",
            command: "git push origin main",
            binary: "git",
            reason: "not-in-allowlist",
          });
          assertEquals(approval.approved, true);
          return { content: "pushed", finishReason: "stop" };
        }),
      askApproval: (request: ApprovalRequest) => {
        approvals.push(request);
        return Promise.resolve({ approved: true });
      },
      onTaskUpdate: (task: Task) => {
        updates.push(task.status.state);
      },
    },
  );

  assertEquals(approvals.length, 1);
  assertEquals(updates, [
    "SUBMITTED",
    "WORKING",
    "INPUT_REQUIRED",
    "WORKING",
    "COMPLETED",
  ]);
  assertEquals(result.task.status.state, "COMPLETED");
});

Deno.test("executeCanonicalWorkerTask classifies user refusals as REJECTED", async () => {
  const updates: string[] = [];

  const result = await executeCanonicalWorkerTask(
    createRequest({ message: "rm -rf /" }),
    {
      createLoop: () =>
        new StubLoop(() =>
          Promise.reject(
            new AgentError("USER_DENIED", { command: "rm -rf /" }, "denied"),
          )
        ),
      onTaskUpdate: (task: Task) => {
        updates.push(task.status.state);
      },
    },
  );

  assertEquals(updates, ["SUBMITTED", "WORKING", "REJECTED"]);
  assertEquals(result.task.status.state, "REJECTED");
  assertEquals(result.error?.code, "AGENT_ERROR");
});

Deno.test("executeCanonicalWorkerTask maps runtime errors to FAILED", async () => {
  const updates: string[] = [];

  const result = await executeCanonicalWorkerTask(createRequest(), {
    createLoop: () =>
      new StubLoop(() => Promise.reject(new Error("network timeout"))),
    onTaskUpdate: (task: Task) => {
      updates.push(task.status.state);
    },
  });

  assertEquals(updates, ["SUBMITTED", "WORKING", "FAILED"]);
  assertEquals(result.task.status.state, "FAILED");
  assertEquals(result.error?.code, "AGENT_ERROR");
});
