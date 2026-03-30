import { assertEquals } from "@std/assert";
import type { WorkerConfig, WorkerPeerSendMessage } from "./worker_protocol.ts";
import {
  type WorkerPoolAgentHandle,
  WorkerPoolPeerRouter,
} from "./worker_pool_peer_router.ts";

interface CapturedWorker {
  messages: unknown[];
  handle: WorkerPoolAgentHandle;
}

function createCapturedWorker(agentId: string, ready = true): CapturedWorker {
  const messages: unknown[] = [];
  return {
    messages,
    handle: {
      agentId,
      ready,
      worker: {
        postMessage(message: unknown) {
          messages.push(message);
        },
      } as Pick<Worker, "postMessage">,
    },
  };
}

function createConfig(): WorkerConfig {
  return {
    agents: {
      defaults: {
        model: "test/model",
        temperature: 0.2,
        maxTokens: 256,
      },
      registry: {
        "agent-a": {
          model: "test/model",
          peers: ["agent-b"],
        },
        "agent-b": {
          model: "test/model",
          acceptFrom: ["agent-a"],
        },
      },
    },
    providers: {},
    tools: {},
  };
}

function createPeerSend(
  overrides: Partial<WorkerPeerSendMessage> = {},
): WorkerPeerSendMessage {
  return {
    type: "peer_send",
    requestId: "req-source",
    toAgent: "agent-b",
    message: "hello peer",
    ...overrides,
  };
}

Deno.test("WorkerPoolPeerRouter routes peer messages and relays peer results", () => {
  const source = createCapturedWorker("agent-a");
  const target = createCapturedWorker("agent-b");
  const agents = new Map<string, WorkerPoolAgentHandle>([
    ["agent-a", source.handle],
    ["agent-b", target.handle],
  ]);
  const seenMessages: Array<{ from: string; to: string; message: string }> = [];
  const router = new WorkerPoolPeerRouter({
    config: createConfig(),
    getAgent: (agentId) => agents.get(agentId),
    onAgentMessage: (from, to, message) => {
      seenMessages.push({ from, to, message });
    },
    timeoutMs: 50,
  });

  router.routeAgentMessage("agent-a", createPeerSend());

  assertEquals(seenMessages, [{
    from: "agent-a",
    to: "agent-b",
    message: "hello peer",
  }]);
  assertEquals(target.messages.length, 1);
  const delivered = target.messages[0] as {
    type: string;
    requestId: string;
    fromAgent: string;
    message: string;
  };
  assertEquals(delivered.type, "peer_deliver");
  assertEquals(delivered.fromAgent, "agent-a");
  assertEquals(delivered.message, "hello peer");

  router.handlePeerResult({
    type: "peer_result",
    requestId: delivered.requestId,
    content: "peer ok",
  });

  assertEquals(source.messages, [{
    type: "peer_response",
    requestId: "req-source",
    content: "peer ok",
    error: undefined,
  }]);
  router.shutdown();
});

Deno.test("WorkerPoolPeerRouter rejects peers outside the sender allowlist", () => {
  const source = createCapturedWorker("agent-a");
  const target = createCapturedWorker("agent-b");
  const agents = new Map<string, WorkerPoolAgentHandle>([
    ["agent-a", source.handle],
    ["agent-b", target.handle],
  ]);
  const router = new WorkerPoolPeerRouter({
    config: createConfig(),
    getAgent: (agentId) => agents.get(agentId),
  });

  router.routeAgentMessage(
    "agent-a",
    createPeerSend({ toAgent: "agent-c", requestId: "req-denied" }),
  );

  assertEquals(target.messages.length, 0);
  assertEquals(source.messages, [{
    type: "peer_response",
    requestId: "req-denied",
    content:
      '[PEER_NOT_ALLOWED] Agent "agent-a" cannot send to "agent-c" (not in peers)',
    error: true,
  }]);
  router.shutdown();
});
