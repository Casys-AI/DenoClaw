import { assertEquals, assertRejects } from "@std/assert";
import { WorkerPeerMessenger } from "./worker_runtime_peer_messenger.ts";
import {
  createWorkerTaskEventEmitter,
} from "./worker_runtime_observability.ts";

Deno.test("WorkerPeerMessenger emits peer_send and resolves peer responses", async () => {
  const messages: unknown[] = [];
  const messenger = new WorkerPeerMessenger(
    (msg) => messages.push(msg),
    createWorkerTaskEventEmitter((msg) => messages.push(msg)),
    () => "agent-alpha",
    50,
  );

  const sendToAgent = messenger.createSendToAgent("task-1", "ctx-1", "trace-1");
  const pending = sendToAgent("agent-beta", "hello");

  assertEquals(messages.length, 2);
  const peerSend = messages[0] as {
    type: string;
    requestId: string;
    toAgent: string;
    message: string;
  };
  assertEquals(peerSend.type, "peer_send");
  assertEquals(peerSend.toAgent, "agent-beta");
  assertEquals(peerSend.message, "hello");

  assertEquals(messages[1], {
    type: "task_observe",
    taskId: "task-1",
    from: "agent-alpha",
    to: "agent-beta",
    message: "hello",
    status: "sent",
    result: undefined,
    traceId: "trace-1",
    contextId: "ctx-1",
  });

  messenger.handlePeerResponse({
    type: "peer_response",
    requestId: peerSend.requestId,
    content: "pong",
  });

  assertEquals(await pending, "pong");
});

Deno.test("WorkerPeerMessenger rejects pending sends on shutdown", async () => {
  const messenger = new WorkerPeerMessenger(
    () => {},
    createWorkerTaskEventEmitter(() => {}),
    () => "agent-alpha",
    50,
  );

  const sendToAgent = messenger.createSendToAgent();
  const pending = sendToAgent("agent-beta", "hello");
  messenger.shutdown();

  await assertRejects(
    () => pending,
    Error,
    "Worker is shutting down",
  );
});
