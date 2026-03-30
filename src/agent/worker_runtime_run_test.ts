import { assertEquals } from "@std/assert";
import type { Task } from "../messaging/a2a/types.ts";
import { createWorkerTaskEventEmitter } from "./worker_runtime_observability.ts";
import { handleWorkerRunRequest } from "./worker_runtime_run.ts";
import type { WorkerResponse, WorkerRunRequest } from "./worker_protocol.ts";

function createRunRequest(
  overrides: Partial<WorkerRunRequest> = {},
): WorkerRunRequest {
  return {
    type: "run",
    requestId: "req-1",
    sessionId: "session-1",
    message: "hello",
    ...overrides,
  };
}

Deno.test("handleWorkerRunRequest returns WORKER_NOT_INITIALIZED before execution", async () => {
  const responses: WorkerResponse[] = [];

  await handleWorkerRunRequest(createRunRequest(), {
    agentId: "agent-a",
    initialized: false,
    taskEvents: createWorkerTaskEventEmitter((msg) => responses.push(msg)),
    respond: (msg) => responses.push(msg),
    executeTask: () => {
      throw new Error(
        "executeTask should not run when worker is uninitialized",
      );
    },
  });

  assertEquals(responses, [
    {
      type: "run_error",
      requestId: "req-1",
      code: "WORKER_NOT_INITIALIZED",
      message: "Worker has not received init message",
    },
  ]);
});

Deno.test("handleWorkerRunRequest emits task lifecycle and returns run_result", async () => {
  const responses: WorkerResponse[] = [];
  const taskStates: string[] = [];

  await handleWorkerRunRequest(createRunRequest({ traceId: "trace-1" }), {
    agentId: "agent-a",
    initialized: true,
    taskEvents: createWorkerTaskEventEmitter((msg) => responses.push(msg)),
    respond: (msg) => responses.push(msg),
    executeTask: (_request, onTaskUpdate) => {
      onTaskUpdate({
        id: "req-1",
        contextId: "req-1",
        kind: "task",
        status: {
          state: "WORKING",
          timestamp: new Date().toISOString(),
        },
        history: [],
        artifacts: [],
      } as Task);
      taskStates.push("WORKING");
      return Promise.resolve({
        response: { content: "done", finishReason: "stop" },
      });
    },
  });

  assertEquals(taskStates, ["WORKING"]);
  assertEquals(responses[0]?.type, "task_started");
  assertEquals(responses[1]?.type, "task_observe");
  assertEquals(responses[2], {
    type: "run_result",
    requestId: "req-1",
    content: "done",
    finishReason: "stop",
  });
  assertEquals(responses[3], {
    type: "task_completed",
    requestId: "req-1",
  });
});
