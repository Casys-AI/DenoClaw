import { assertEquals } from "@std/assert";
import { createWorkerTaskEventEmitter } from "./worker_runtime_observability.ts";
import { handleWorkerPeerDeliverRequest } from "./worker_runtime_peer_delivery.ts";
import type {
  WorkerPeerDeliverRequest,
  WorkerResponse,
} from "./worker_protocol.ts";

function createPeerDeliverRequest(
  overrides: Partial<WorkerPeerDeliverRequest> = {},
): WorkerPeerDeliverRequest {
  return {
    type: "peer_deliver",
    requestId: "peer-1",
    fromAgent: "agent-a",
    message: "hello peer",
    ...overrides,
  };
}

Deno.test("handleWorkerPeerDeliverRequest rejects uninitialized workers", async () => {
  const responses: WorkerResponse[] = [];

  await handleWorkerPeerDeliverRequest(createPeerDeliverRequest(), {
    agentId: "agent-b",
    initialized: false,
    taskEvents: createWorkerTaskEventEmitter((msg) => responses.push(msg)),
    respond: (msg) => responses.push(msg),
    processPeerMessage: () => {
      throw new Error("processPeerMessage should not run when uninitialized");
    },
  });

  assertEquals(responses[2], {
    type: "task_observe",
    taskId: "peer-1",
    from: "agent-a",
    to: "agent-b",
    message: "hello peer",
    status: "failed",
    result: "Worker not initialized",
    traceId: undefined,
    contextId: "peer-1",
  });
  assertEquals(responses[3], {
    type: "task_completed",
    requestId: "peer-1",
  });
  assertEquals(responses[4], {
    type: "peer_result",
    requestId: "peer-1",
    content: "Worker not initialized",
    error: true,
  });
});

Deno.test("handleWorkerPeerDeliverRequest emits peer_result on success", async () => {
  const responses: WorkerResponse[] = [];

  await handleWorkerPeerDeliverRequest(
    createPeerDeliverRequest({ traceId: "trace-peer" }),
    {
      agentId: "agent-b",
      initialized: true,
      taskEvents: createWorkerTaskEventEmitter((msg) => responses.push(msg)),
      respond: (msg) => responses.push(msg),
      processPeerMessage: () => Promise.resolve("peer ok"),
    },
  );

  assertEquals(responses[0]?.type, "task_started");
  assertEquals(responses[1]?.type, "task_observe");
  assertEquals(responses[2], {
    type: "task_observe",
    taskId: "peer-1",
    from: "agent-a",
    to: "agent-b",
    message: "hello peer",
    status: "completed",
    result: "peer ok",
    traceId: "trace-peer",
    contextId: "peer-1",
  });
  assertEquals(responses[3], {
    type: "peer_result",
    requestId: "peer-1",
    content: "peer ok",
  });
  assertEquals(responses[4], {
    type: "task_completed",
    requestId: "peer-1",
  });
});
