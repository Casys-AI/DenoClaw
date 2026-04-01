import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { DenoClawError } from "../shared/errors.ts";
import { DENOCLAW_AGENT_PROTOCOL } from "./agent_socket_protocol.ts";
import { BrokerServer, type BrokerServerDeps } from "./broker/server.ts";
import { BrokerCronManager } from "./broker/cron_manager.ts";
import { AuthManager } from "./auth.ts";
import { MetricsCollector } from "../telemetry/metrics.ts";
import { TunnelRegistry } from "./broker/tunnel_registry.ts";
import { createLegacyAgentConfigKey } from "./agent_store.ts";
import {
  DENOCLAW_TUNNEL_PROTOCOL,
  getAcceptedTunnelProtocol,
  WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
} from "./tunnel_protocol.ts";
import {
  createAwaitedInputMetadata,
  createResumePayloadMetadata,
} from "../messaging/a2a/input_metadata.ts";
import type { Config } from "../config/types.ts";
import type { BrokerMessage } from "./types.ts";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import {
  createBroadcastChannelRoutePlan,
  createDirectChannelRoutePlan,
} from "./channel_routing/types.ts";
import type { BrokerTaskMetadata } from "./broker/persistence.ts";

function createConfig(): Config {
  return {
    providers: {},
    agents: {
      defaults: { model: "test/model", temperature: 0.2, maxTokens: 256 },
    },
    tools: {},
    channels: {},
  };
}

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

function bodyBrokerMetadata(task: Task): BrokerTaskMetadata {
  return (task.metadata?.broker ?? {}) as BrokerTaskMetadata;
}

async function seedPeerPolicy(
  kv: Deno.Kv,
  fromAgentId: string,
  targetAgentId: string,
): Promise<void> {
  await kv.set(["agents", fromAgentId, "config"], {
    peers: [targetAgentId],
  });
  await kv.set(["agents", targetAgentId, "config"], {
    acceptFrom: [fromAgentId],
  });
  await seedAgentEndpoint(kv, fromAgentId);
  await seedAgentEndpoint(kv, targetAgentId);
}

async function seedAgentEndpoint(
  kv: Deno.Kv,
  agentId: string,
): Promise<void> {
  await kv.set(["agents", agentId, "endpoint"], `https://${agentId}.example`);
}

function createQueueBackedFetchBridge(kv: Deno.Kv): typeof fetch {
  return ((
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = init?.body;
    if (typeof raw !== "string") {
      throw new Error("Expected JSON broker message body for test HTTP bridge");
    }
    const message = JSON.parse(raw) as BrokerMessage;
    return kv.enqueue(message).then(() =>
      Response.json({ ok: true }, { status: 202 })
    );
  }) as typeof fetch;
}

function createTestBroker(
  config: Config,
  deps: BrokerServerDeps,
): BrokerServer {
  if (!deps.kv || deps.fetchFn) {
    return new BrokerServer(config, deps);
  }
  return new BrokerServer(config, {
    ...deps,
    fetchFn: createQueueBackedFetchBridge(deps.kv),
  });
}

function createQueueCollector(kv: Deno.Kv): BrokerMessage[] {
  const messages: BrokerMessage[] = [];
  kv.listenQueue((raw: unknown) => {
    messages.push(raw as BrokerMessage);
  });
  return messages;
}

function withBrokerAuth(init: RequestInit = {}): RequestInit {
  const token = Deno.env.get("DENOCLAW_API_TOKEN");
  if (!token) return init;

  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }

  return { ...init, headers };
}

async function waitForCollectedMessage(
  messages: BrokerMessage[],
  predicate: (message: BrokerMessage) => boolean,
): Promise<BrokerMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for collected message");
}

function waitForQueuedMessage(
  kv: Deno.Kv,
  predicate: (message: BrokerMessage) => boolean,
): Promise<BrokerMessage> {
  let settled = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Timed out waiting for queued message"));
    }, 5_000);

    kv.listenQueue((raw: unknown) => {
      if (settled) return;
      const message = raw as BrokerMessage;
      if (!predicate(message)) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function createAgentEndpointFetchCollector(
  status = 202,
): {
  calls: Array<{ url: string; init?: RequestInit }>;
  fetch: typeof globalThis.fetch;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: ((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return Promise.resolve(Response.json({ ok: true }, { status }));
    }) as typeof fetch,
  };
}

function createSocketCollector(): {
  messages: BrokerMessage[];
  socket: WebSocket;
} {
  const messages: BrokerMessage[] = [];
  return {
    messages,
    socket: {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send(raw: string) {
        messages.push(JSON.parse(raw) as BrokerMessage);
      },
      close() {},
    } as unknown as WebSocket,
  };
}

function registerConnectedAgentSocket(
  broker: BrokerServer,
  agentId: string,
  socket: WebSocket,
): void {
  (
    broker as unknown as {
      connectedAgents: {
        register(
          agentId: string,
          socket: WebSocket,
          authIdentity: string,
        ): void;
      };
    }
  ).connectedAgents.register(agentId, socket, "test");
}

function attachConnectedAgentInbox(
  broker: BrokerServer,
  agentId: string,
): BrokerMessage[] {
  const { messages, socket } = createSocketCollector();
  registerConnectedAgentSocket(broker, agentId, socket);
  return messages;
}

function attachRemoteBrokerTunnelInbox(
  tunnelRegistry: TunnelRegistry,
  brokerId: string,
): BrokerMessage[] {
  const { messages, socket } = createSocketCollector();
  tunnelRegistry.register(brokerId, socket, {
    tunnelId: brokerId,
    type: "instance",
    tools: [],
    agents: [],
    allowedAgents: [],
  });
  return messages;
}

Deno.test(
  "BrokerServer.submitAgentTask persists canonical task and forwards canonical task submit",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const { messages: socketMessages, socket } = createSocketCollector();
    const tunnelRegistry = new TunnelRegistry();

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      attachRemoteBrokerTunnelInbox(tunnelRegistry, "broker-remote");
      const broker = createTestBroker(createConfig(), {
        kv,
        tunnelRegistry,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      attachConnectedAgentInbox(broker, "agent-beta");
      registerConnectedAgentSocket(broker, "agent-beta", socket);

      const task = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-1",
        contextId: "ctx-1",
        taskMessage: createMessage("Summarise this"),
        metadata: { source: "test" },
      });

      assertEquals(task.id, "task-1");
      assertEquals(task.contextId, "ctx-1");
      assertEquals(task.status.state, "SUBMITTED");
      assertEquals(task.metadata?.broker, {
        submittedBy: "agent-alpha",
        targetAgent: "agent-beta",
        request: { source: "test" },
      });

      const persisted = await broker.getTask({ taskId: "task-1" });
      assertExists(persisted);
      assertEquals(persisted?.metadata?.broker, task.metadata?.broker);

      assertEquals(socketMessages.length, 1);
      const forwarded = socketMessages[0] as Extract<
        BrokerMessage,
        { type: "task_submit" }
      >;
      assertEquals(forwarded.type, "task_submit");
      assertEquals(forwarded.payload.taskId, "task-1");
      assertEquals(forwarded.payload.contextId, "ctx-1");
      assertEquals(forwarded.payload.targetAgent, "agent-beta");
      assertEquals(forwarded.payload.taskMessage?.parts[0], {
        kind: "text",
        text: "Summarise this",
      });
      assertEquals(forwarded.payload.metadata, { source: "test" });

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.recordTaskResult persists canonical execution progress and completion",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      attachConnectedAgentInbox(broker, "agent-beta");

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-runtime",
        contextId: "ctx-runtime",
        taskMessage: createMessage("Handle this"),
      });

      const working = await broker.recordTaskResult("agent-beta", {
        task: {
          ...submitted,
          status: {
            state: "WORKING",
            timestamp: new Date().toISOString(),
          },
        },
      });
      assertExists(working);
      assertEquals(working?.status.state, "WORKING");

      const completed = await broker.recordTaskResult("agent-beta", {
        task: {
          ...submitted,
          status: {
            state: "COMPLETED",
            timestamp: new Date().toISOString(),
            message: {
              messageId: crypto.randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: "Done" }],
            },
          },
          artifacts: [
            {
              artifactId: "task-runtime:result",
              name: "result",
              parts: [{ kind: "text", text: "Done" }],
            },
          ],
        },
      });

      assertExists(completed);
      assertEquals(completed?.status.state, "COMPLETED");
      assertEquals(completed?.artifacts[0]?.parts[0], {
        kind: "text",
        text: "Done",
      });
      assertEquals(completed?.metadata?.broker, {
        submittedBy: "agent-alpha",
        targetAgent: "agent-beta",
      });

      const persisted = await broker.getTask({ taskId: submitted.id });
      assertEquals(persisted?.status.state, "COMPLETED");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.recordTaskResult rejects updates from non-target agents",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      attachConnectedAgentInbox(broker, "agent-beta");

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-forbidden",
        taskMessage: createMessage("Handle this"),
      });

      await assertRejects(
        () =>
          broker.recordTaskResult("agent-gamma", {
            task: {
              ...submitted,
              status: {
                state: "WORKING",
                timestamp: new Date().toISOString(),
              },
            },
          }),
        Error,
        'Only "agent-beta" can report the result',
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.continueAgentTask forwards canonical continuation without mutating runtime state locally",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const { messages: socketMessages, socket } = createSocketCollector();

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      registerConnectedAgentSocket(broker, "agent-beta", socket);

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-continue",
        contextId: "ctx-continue",
        message: createMessage("Need confirmation"),
      });

      const paused: Task = {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: {
            awaitedInput: {
              kind: "confirmation",
              prompt: "continue?",
            },
          },
        },
      };
      await kv.set(["a2a_tasks", paused.id], paused);

      const resumed = await broker.continueAgentTask("agent-alpha", {
        taskId: paused.id,
        continuationMessage: createMessage("Confirmed, continue"),
        metadata: createResumePayloadMetadata({
          kind: "confirmation",
          approved: true,
        }),
      });

      assertExists(resumed);
      assertEquals(resumed?.status.state, "INPUT_REQUIRED");

      assertEquals(socketMessages.length, 2);
      const forwarded = JSON.parse(
        JSON.stringify(socketMessages[1]),
      ) as Extract<BrokerMessage, { type: "task_continue" }>;
      assertEquals(forwarded.payload.taskId, paused.id);
      assertEquals(forwarded.payload.continuationMessage?.parts[0], {
        kind: "text",
        text: "Confirmed, continue",
      });
      assertEquals(forwarded.payload.metadata, {
        resume: { kind: "confirmation", approved: true },
      });

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer handles federation link open and acknowledges",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const tunnelRegistry = new TunnelRegistry();
    const remoteMessages = attachRemoteBrokerTunnelInbox(
      tunnelRegistry,
      "broker-remote",
    );

    try {
      const broker = new BrokerServer(createConfig(), {
        kv,
        tunnelRegistry,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      const ackPromise = waitForCollectedMessage(
        remoteMessages,
        (message) =>
          message.type === "federation_link_ack" &&
          message.to === "broker-remote",
      );

      await broker.handleIncomingMessage({
        id: "fed-open-1",
        from: "broker-remote",
        to: "broker",
        type: "federation_link_open",
        payload: {
          linkId: "link-a-b",
          localBrokerId: "broker-local",
          remoteBrokerId: "broker-remote",
          traceId: "trace-open-1",
        },
        timestamp: new Date().toISOString(),
      });

      const persisted = await kv.get(["federation", "links", "link-a-b"]);
      assertExists(persisted.value);
      assertEquals((persisted.value as { state: string }).state, "active");

      const ack = (await ackPromise) as Extract<
        BrokerMessage,
        { type: "federation_link_ack" }
      >;
      assertEquals(ack.payload.linkId, "link-a-b");
      assertEquals(ack.payload.remoteBrokerId, "broker-remote");
      assertEquals(ack.payload.accepted, true);
      assertEquals(ack.payload.traceId, "trace-open-1");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer federation_route_probe evaluates policy and catalog then replies",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const tunnelRegistry = new TunnelRegistry();
    const remoteMessages = attachRemoteBrokerTunnelInbox(
      tunnelRegistry,
      "broker-origin",
    );

    try {
      const broker = new BrokerServer(createConfig(), {
        kv,
        tunnelRegistry,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });

      await kv.set(
        ["federation", "catalog", "broker-remote"],
        [
          {
            remoteBrokerId: "broker-remote",
            agentId: "agent-x",
            card: {},
            capabilities: ["chat"],
            visibility: "public",
          },
        ],
      );
      await kv.set(["federation", "policies", "broker-origin"], {
        policyId: "broker-origin",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-remote"],
        denyAgentIds: [],
        allowAgentIds: ["agent-x"],
      });

      const ackPromise = waitForCollectedMessage(
        remoteMessages,
        (message) =>
          message.type === "federation_link_ack" &&
          message.to === "broker-origin",
      );

      await broker.handleIncomingMessage({
        id: "fed-probe-1",
        from: "broker-origin",
        to: "broker",
        type: "federation_route_probe",
        payload: {
          remoteBrokerId: "broker-remote",
          targetAgent: "agent-x",
          taskId: "task-123",
          contextId: "ctx-123",
          traceId: "trace-probe-1",
        },
        timestamp: new Date().toISOString(),
      });

      const ack = (await ackPromise) as Extract<
        BrokerMessage,
        { type: "federation_link_ack" }
      >;
      assertEquals(ack.payload.accepted, true);
      assertEquals(ack.payload.reason, "route_available");
      assertEquals(ack.payload.remoteBrokerId, "broker-remote");
      assertEquals(ack.payload.traceId, "trace-probe-1");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer federation_route_probe enforces bilateral policy",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const tunnelRegistry = new TunnelRegistry();
    const remoteMessages = attachRemoteBrokerTunnelInbox(
      tunnelRegistry,
      "broker-origin",
    );

    try {
      const broker = new BrokerServer(createConfig(), {
        kv,
        tunnelRegistry,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });

      await kv.set(
        ["federation", "catalog", "broker-remote"],
        [
          {
            remoteBrokerId: "broker-remote",
            agentId: "agent-denied-by-remote",
            card: {},
            capabilities: ["chat"],
            visibility: "public",
          },
        ],
      );

      await kv.set(["federation", "policies", "broker-origin"], {
        policyId: "broker-origin",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-remote"],
        denyAgentIds: [],
        allowAgentIds: ["agent-denied-by-remote"],
      });

      await kv.set(["federation", "policies", "broker-remote"], {
        policyId: "broker-remote",
        preferLocal: false,
        preferredRemoteBrokerIds: ["broker-origin"],
        denyAgentIds: ["agent-denied-by-remote"],
        allowAgentIds: ["agent-denied-by-remote"],
      });

      const ackPromise = waitForCollectedMessage(
        remoteMessages,
        (message) =>
          message.type === "federation_link_ack" &&
          message.to === "broker-origin",
      );

      await broker.handleIncomingMessage({
        id: "fed-probe-bilateral-1",
        from: "broker-origin",
        to: "broker",
        type: "federation_route_probe",
        payload: {
          remoteBrokerId: "broker-remote",
          targetAgent: "agent-denied-by-remote",
          taskId: "task-456",
          contextId: "ctx-456",
          traceId: "trace-probe-2",
        },
        timestamp: new Date().toISOString(),
      });

      const ack = (await ackPromise) as Extract<
        BrokerMessage,
        { type: "federation_link_ack" }
      >;
      assertEquals(ack.payload.accepted, false);
      assertEquals(ack.payload.reason, "denied_by_policy");
      assertEquals(ack.payload.remoteBrokerId, "broker-remote");
      assertEquals(ack.payload.traceId, "trace-probe-2");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer keeps canonical A2A task flow after federation control messages",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const { messages: socketMessages, socket } = createSocketCollector();
    const tunnelRegistry = new TunnelRegistry();

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      attachRemoteBrokerTunnelInbox(tunnelRegistry, "broker-remote");
      const broker = createTestBroker(createConfig(), {
        kv,
        tunnelRegistry,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      registerConnectedAgentSocket(broker, "agent-beta", socket);

      await broker.handleIncomingMessage({
        id: "fed-open-a2a-1",
        from: "broker-remote",
        to: "broker",
        type: "federation_link_open",
        payload: {
          linkId: "link-a2a",
          localBrokerId: "broker-local",
          remoteBrokerId: "broker-remote",
          traceId: "trace-open-a2a-1",
        },
        timestamp: new Date().toISOString(),
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-a2a-regression",
        message: createMessage("Still canonical"),
      });

      assertEquals(submitted.status.state, "SUBMITTED");
      const submitForwarded = JSON.parse(
        JSON.stringify(socketMessages[0]),
      ) as Extract<BrokerMessage, { type: "task_submit" }>;
      assertEquals(submitForwarded.payload.targetAgent, "agent-beta");

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
        },
      });

      await broker.continueAgentTask("agent-alpha", {
        taskId: submitted.id,
        message: createMessage("Continue please"),
      });

      const continuedForwarded = JSON.parse(
        JSON.stringify(socketMessages[1]),
      ) as Extract<BrokerMessage, { type: "task_continue" }>;
      assertEquals(continuedForwarded.payload.taskId, submitted.id);

      await broker.cancelTask({ taskId: submitted.id });
      const canceled = await broker.getTask({ taskId: submitted.id });
      assertEquals(canceled?.status.state, "CANCELED");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.continueAgentTask classifies explicit refusal as REJECTED",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-reject",
        taskMessage: createMessage("Dangerous action"),
      });

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
        },
      });

      const rejected = await broker.continueAgentTask("agent-alpha", {
        taskId: submitted.id,
        continuationMessage: createMessage("No"),
        metadata: createResumePayloadMetadata({
          kind: "confirmation",
          approved: false,
        }),
      });

      assertExists(rejected);
      assertEquals(rejected?.status.state, "REJECTED");
      assertEquals(rejected?.history.at(-1)?.parts[0], {
        kind: "text",
        text: "No",
      });

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test("BrokerServer.submitAgentTask enforces peer policy", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await kv.set(["agents", "agent-alpha", "config"], { peers: [] });
    await kv.set(["agents", "agent-beta", "config"], {
      acceptFrom: ["agent-alpha"],
    });

    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    await assertRejects(
      () =>
        broker.submitAgentTask("agent-alpha", {
          targetAgent: "agent-beta",
          taskId: "blocked-task",
          message: createMessage("Blocked"),
        }),
      Error,
      'Add "agent-beta" to agent-alpha.peers',
    );

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test(
  "BrokerServer returns PRIVILEGE_ELEVATION_REQUIRED and uses default sandbox permissions",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      let sandboxCalls = 0;
      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => {
            sandboxCalls++;
            return Promise.resolve({ success: true, output: "" });
          },
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });
      const alphaMessages = attachConnectedAgentInbox(broker, "agent-alpha");

      const replyPromise = waitForCollectedMessage(
        alphaMessages,
        (message) => message.type === "error" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-elevation",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hi" },
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.requiredPermissions, ["write"]);
      assertEquals(reply.payload.context?.agentAllowed, ["read"]);
      assertEquals(reply.payload.context?.denied, ["write"]);
      assertEquals(reply.payload.context?.suggestedGrants, [
        { permission: "write", paths: ["note.txt"] },
      ]);
      assertEquals(reply.payload.context?.privilegeElevationSupported, true);
      assertEquals(reply.payload.context?.elevationAvailable, false);
      assertEquals(reply.payload.context?.elevationReason, "no_channel");
      assertEquals(
        reply.payload.recovery,
        "Attach an elevation channel or update agent sandbox.allowedPermissions / broker policy to allow write_file (write paths=[note.txt])",
      );
      assertEquals(
        typeof reply.payload.context?.capabilitiesFingerprint,
        "string",
      );
      assertEquals(
        reply.payload.context?.capabilitiesVersion,
        "runtime-capabilities-v1",
      );
      assertEquals(sandboxCalls, 0);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer resolves legacy agent config namespace for tool permission checks",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      let sandboxCalls = 0;
      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => {
            sandboxCalls++;
            return Promise.resolve({ success: true, output: "legacy-ok" });
          },
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });
      const alphaMessages = attachConnectedAgentInbox(broker, "agent-alpha");

      await kv.set(createLegacyAgentConfigKey("agent-alpha"), {
        sandbox: {
          allowedPermissions: ["write"],
        },
      });

      const replyPromise = waitForCollectedMessage(
        alphaMessages,
        (message) =>
          message.type === "tool_response" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-legacy-config",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hi" },
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(reply.payload.success, true);
      assertEquals(reply.payload.output, "legacy-ok");
      assertEquals(sandboxCalls, 1);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer gates broker-owned cron tools behind schedule permission",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      const cronManager = new BrokerCronManager(kv, {
        registerDenoCron: false,
      });
      const broker = createTestBroker(config, {
        kv,
        cronManager,
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });
      const alphaMessages = attachConnectedAgentInbox(broker, "agent-alpha");

      const replyPromise = waitForCollectedMessage(
        alphaMessages,
        (message) => message.type === "error" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-cron-denied",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "create_cron",
          args: {
            name: "daily-check",
            schedule: "0 8 * * *",
            prompt: "Check messages",
          },
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.requiredPermissions, ["schedule"]);
      assertEquals(reply.payload.context?.agentAllowed, ["read"]);
      assertEquals(reply.payload.context?.denied, ["schedule"]);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer inherits channel-backed privilege elevation availability for delegated child tasks",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");

      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "" }),
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });
      attachConnectedAgentInbox(broker, "agent-alpha");
      const betaMessages = attachConnectedAgentInbox(broker, "agent-beta");

      const parent = await broker.submitChannelMessage(
        {
          id: "telegram-parent-msg",
          sessionId: "telegram-parent-session",
          userId: "999",
          content: "Ask alice to delegate",
          channelType: "telegram",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "telegram",
            userId: "999",
            roomId: "999",
          },
        },
        {
          routePlan: createDirectChannelRoutePlan("agent-alpha"),
          taskId: "parent-channel-task",
        },
      );

      const child = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "child-delegated-task",
        parentTaskId: parent.id,
        taskMessage: createMessage("Write note.txt"),
      });

      const childBrokerMetadata = child.metadata?.broker as
        | { parentTaskId?: string; channel?: unknown }
        | undefined;
      const parentBrokerMetadata = parent.metadata?.broker as
        | { channel?: unknown }
        | undefined;
      assertEquals(child.contextId, parent.contextId);
      assertEquals(childBrokerMetadata?.parentTaskId, parent.id);
      assertEquals(
        childBrokerMetadata?.channel,
        parentBrokerMetadata?.channel,
      );

      const replyPromise = waitForCollectedMessage(
        betaMessages,
        (message) =>
          message.type === "error" && message.to === "agent-beta" &&
          message.id === "tool-req-child-channel-elevation",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-child-channel-elevation",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hi" },
          taskId: child.id,
          contextId: child.contextId,
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.elevationAvailable, true);
      assertEquals(reply.payload.context?.elevationReason, undefined);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer disables privilege elevation per agent while keeping structured denials",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      let sandboxCalls = 0;
      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => {
            sandboxCalls++;
            return Promise.resolve({ success: true, output: "" });
          },
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });
      const betaMessages = attachConnectedAgentInbox(broker, "agent-beta");

      await kv.set(["agents", "agent-beta", "config"], {
        sandbox: {
          allowedPermissions: ["read"],
          privilegeElevation: {
            enabled: false,
          },
        },
      });

      const replyPromise = waitForCollectedMessage(
        betaMessages,
        (message) => message.type === "error" && message.to === "agent-beta",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-disabled-elevation",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hi" },
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.privilegeElevationSupported, false);
      assertEquals(reply.payload.context?.elevationAvailable, false);
      assertEquals(
        reply.payload.context?.elevationReason,
        "disabled_for_agent",
      );
      assertEquals(reply.payload.context?.privilegeElevationScopes, []);
      assertEquals(
        reply.payload.recovery,
        "Update agent sandbox.allowedPermissions or broker policy to allow write_file (write paths=[note.txt])",
      );
      assertEquals(sandboxCalls, 0);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer marks privilege elevation as available for channel-backed tasks",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "" }),
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });
      const betaMessages = attachConnectedAgentInbox(broker, "agent-beta");

      const submitted = await broker.submitChannelMessage(
        {
          id: "telegram-msg-elevation",
          sessionId: "telegram-elevation-session",
          userId: "999",
          content: "Write note.txt",
          channelType: "telegram",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "telegram",
            userId: "999",
            roomId: "999",
          },
        },
        {
          routePlan: createDirectChannelRoutePlan("agent-beta"),
          taskId: "channel-elevation-task",
        },
      );

      const replyPromise = waitForCollectedMessage(
        betaMessages,
        (message) =>
          message.type === "error" && message.to === "agent-beta" &&
          message.id === "tool-req-channel-elevation",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-channel-elevation",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hi" },
          taskId: submitted.id,
          contextId: submitted.contextId,
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.privilegeElevationSupported, true);
      assertEquals(reply.payload.context?.elevationAvailable, true);
      assertEquals(reply.payload.context?.elevationReason, undefined);
      assertEquals(
        reply.payload.recovery,
        "Grant temporary privilege elevation for write_file (write paths=[note.txt]) or update agent sandbox.allowedPermissions / broker policy",
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer inherits elevation channel lineage to delegated child tasks via parentTaskId",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };

      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "" }),
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });
      attachConnectedAgentInbox(broker, "agent-alpha");
      const betaMessages = attachConnectedAgentInbox(broker, "agent-beta");

      const parent = await broker.submitChannelMessage(
        {
          id: "telegram-parent-msg",
          sessionId: "telegram-parent-session",
          userId: "999",
          content: "Delegate this write task",
          channelType: "telegram",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "telegram",
            userId: "999",
            roomId: "999",
          },
        },
        {
          routePlan: createDirectChannelRoutePlan("agent-alpha"),
          taskId: "channel-parent-task",
        },
      );

      const child = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "delegated-child-task",
        parentTaskId: parent.id,
        taskMessage: createMessage("Write note.txt"),
      });

      assertEquals(child.contextId, parent.contextId);
      assertEquals(child.metadata?.broker, {
        submittedBy: "agent-alpha",
        targetAgent: "agent-beta",
        parentTaskId: parent.id,
        channel: {
          channelType: "telegram",
          sessionId: "telegram-parent-session",
          userId: "999",
          address: {
            channelType: "telegram",
            userId: "999",
            roomId: "999",
          },
        },
      });

      const replyPromise = waitForCollectedMessage(
        betaMessages,
        (message) =>
          message.type === "error" && message.to === "agent-beta" &&
          message.id === "tool-req-delegated-channel-elevation",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-delegated-channel-elevation",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hi" },
          taskId: child.id,
          contextId: child.contextId,
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.privilegeElevationSupported, true);
      assertEquals(reply.payload.context?.elevationAvailable, true);
      assertEquals(reply.payload.context?.elevationReason, undefined);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer rejects delegated child lineage when parent is owned by another agent",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-beta", "agent-gamma");
      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      attachConnectedAgentInbox(broker, "agent-alpha");

      const parent = await broker.submitChannelMessage(
        {
          id: "telegram-parent-mismatch-msg",
          sessionId: "telegram-parent-mismatch-session",
          userId: "999",
          content: "Parent task for alpha only",
          channelType: "telegram",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "telegram",
            userId: "999",
            roomId: "999",
          },
        },
        {
          routePlan: createDirectChannelRoutePlan("agent-alpha"),
          taskId: "channel-parent-mismatch-task",
        },
      );

      await assertRejects(
        () =>
          broker.submitAgentTask("agent-beta", {
            targetAgent: "agent-gamma",
            taskId: "delegated-invalid-parent-task",
            parentTaskId: parent.id,
            taskMessage: createMessage("Should fail"),
          }),
        DenoClawError,
        "Submit child tasks only from a parent task currently owned by the submitting agent",
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer preserves elevation availability across delegated child tasks",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const config = createConfig();
      config.agents.defaults.sandbox = {
        allowedPermissions: ["read"],
      };
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");

      const broker = createTestBroker(config, {
        kv,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "" }),
          resolveToolPermissions: () => ["write"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });
      attachConnectedAgentInbox(broker, "agent-alpha");
      const betaMessages = attachConnectedAgentInbox(broker, "agent-beta");

      const parentTask = await broker.submitChannelMessage(
        {
          id: "telegram-msg-parent-elevation",
          sessionId: "telegram-parent-session",
          userId: "999",
          content: "Delegate this",
          channelType: "telegram",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "telegram",
            userId: "999",
            roomId: "999",
          },
        },
        {
          routePlan: createDirectChannelRoutePlan("agent-alpha"),
          taskId: "channel-parent-task",
        },
      );

      const childTask = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "delegated-child-task",
        parentTaskId: parentTask.id,
        taskMessage: createMessage("Write delegated.txt"),
      });

      const replyPromise = waitForCollectedMessage(
        betaMessages,
        (message) =>
          message.type === "error" && message.to === "agent-beta" &&
          message.id === "tool-req-delegated-elevation",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-delegated-elevation",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "delegated.txt", content: "hi" },
          taskId: childTask.id,
          contextId: childTask.contextId,
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.privilegeElevationSupported, true);
      assertEquals(reply.payload.context?.elevationAvailable, true);
      assertEquals(reply.payload.context?.elevationReason, undefined);

      const persistedChild = await broker.getTask({ taskId: childTask.id });
      const childBrokerMetadata = persistedChild?.metadata?.broker as
        | {
          parentTaskId?: string;
          channel?: { sessionId?: string; channelType?: string };
        }
        | undefined;
      assertEquals(childBrokerMetadata?.parentTaskId, parentTask.id);
      assertEquals(
        childBrokerMetadata?.channel?.sessionId,
        "telegram-parent-session",
      );
      assertEquals(childBrokerMetadata?.channel?.channelType, "telegram");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer rejects privilege-elevation resume when the target agent disables it",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      await kv.set(["agents", "agent-beta", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
          privilegeElevation: {
            enabled: false,
          },
        },
      });

      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-disabled-elevation",
        contextId: "ctx-disabled-elevation",
        taskMessage: createMessage("Write note.txt"),
      });

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["note.txt"] }],
            scope: "task",
            prompt: "Need temporary write access",
          }),
        },
      });

      await assertRejects(
        () =>
          broker.continueAgentTask("agent-alpha", {
            taskId: submitted.id,
            continuationMessage: createMessage("Grant write"),
            metadata: createResumePayloadMetadata({
              kind: "privilege-elevation",
              approved: true,
            }),
          }),
        DenoClawError,
        "Enable sandbox.privilegeElevation.enabled",
      );

      const persisted = await broker.getTask({ taskId: submitted.id });
      const privilegeGrants = ((persisted?.metadata?.broker as
        | { privilegeElevationGrants?: unknown[] }
        | undefined)?.privilegeElevationGrants) ?? [];
      assertEquals(privilegeGrants, []);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer rejects expired privilege-elevation resumes and expires session grants",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      await kv.set(["agents", "agent-beta", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
          privilegeElevation: {
            sessionGrantTtlSec: 1,
          },
        },
      });

      const queueMessages = createQueueCollector(kv);
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "ok" }),
          resolveToolPermissions: (tool) => {
            switch (tool) {
              case "write_file":
                return ["write"];
              default:
                return [];
            }
          },
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-expired-elevation",
        contextId: "ctx-expired-elevation",
        taskMessage: createMessage("Write note.txt"),
      });

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["note.txt"] }],
            scope: "task",
            prompt: "Need temporary write access",
            expiresAt: "2026-03-31T00:00:00.000Z",
          }),
        },
      });

      const expiredOnContinue = await broker.continueAgentTask("agent-alpha", {
        taskId: submitted.id,
        continuationMessage: createMessage("Grant write"),
        metadata: createResumePayloadMetadata({
          kind: "privilege-elevation",
          approved: true,
        }),
      });
      assertEquals(expiredOnContinue?.status.state, "FAILED");
      assertEquals(expiredOnContinue?.status.metadata, {
        errorCode: "PRIVILEGE_ELEVATION_REQUEST_EXPIRED",
        errorContext: {
          expiresAt: "2026-03-31T00:00:00.000Z",
        },
      });
      assertEquals(expiredOnContinue?.status.message?.parts[0], {
        kind: "text",
        text:
          "Privilege elevation request expired; request a fresh elevation to continue",
      });
      const loadedExpired = await broker.getTask({ taskId: submitted.id });
      assertEquals(loadedExpired?.status.state, "FAILED");

      await kv.set(
        [
          "a2a_contexts",
          "agent-beta",
          "ctx-expired-elevation",
          "privilege_elevation_grants",
        ],
        [{
          kind: "privilege-elevation",
          scope: "session",
          grants: [{ permission: "write", paths: ["note.txt"] }],
          grantedAt: "2026-03-31T00:00:00.000Z",
          expiresAt: "2026-03-31T00:00:01.000Z",
          source: "broker-resume",
        }],
      );

      const realDateNow = Date.now;
      Date.now = () => Date.parse("2026-03-31T00:00:02.000Z");
      try {
        await (
          broker as unknown as {
            handleToolRequest(
              msg: Extract<BrokerMessage, { type: "tool_request" }>,
            ): Promise<void>;
          }
        ).handleToolRequest({
          id: "tool-expired-session-grant",
          from: "agent-beta",
          to: "broker",
          type: "tool_request",
          timestamp: new Date().toISOString(),
          payload: {
            tool: "write_file",
            args: { path: "note.txt", content: "hello" },
            taskId: submitted.id,
            contextId: "ctx-expired-elevation",
          },
        });
      } finally {
        Date.now = realDateNow;
      }

      const deniedReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "error" &&
          message.to === "agent-beta" &&
          message.id === "tool-expired-session-grant",
      )) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(deniedReply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer stores privilege-elevation grants on resume and consumes once grants only when used",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      await kv.set(["agents", "agent-beta", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
        },
      });

      const executedTools: string[] = [];
      const queueMessages = createQueueCollector(kv);
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: (request) => {
            executedTools.push(request.tool);
            return Promise.resolve({ success: true, output: "ok" });
          },
          resolveToolPermissions: (tool) => {
            switch (tool) {
              case "read_file":
                return ["read"];
              case "write_file":
                return ["write"];
              default:
                return [];
            }
          },
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-privilege-grant",
        taskMessage: createMessage("Update note.txt"),
      });

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["note.txt"] }],
            scope: "once",
            prompt: "Need temporary write access",
          }),
        },
      });

      await broker.continueAgentTask("agent-alpha", {
        taskId: submitted.id,
        continuationMessage: createMessage("Grant write once"),
        metadata: createResumePayloadMetadata({
          kind: "privilege-elevation",
          approved: true,
        }),
      });

      let persisted = await broker.getTask({ taskId: submitted.id });
      let privilegeGrants = ((persisted?.metadata?.broker as
        | { privilegeElevationGrants?: unknown[] }
        | undefined)?.privilegeElevationGrants) ?? [];
      const firstPrivilegeGrant = privilegeGrants[0] as
        | Record<string, unknown>
        | undefined;
      assertEquals(privilegeGrants.length, 1);
      assertEquals(firstPrivilegeGrant?.kind, "privilege-elevation");
      assertEquals(firstPrivilegeGrant?.scope, "once");
      assertEquals(firstPrivilegeGrant?.grants, [
        { permission: "write", paths: ["note.txt"] },
      ]);
      assertEquals(firstPrivilegeGrant?.source, "broker-resume");
      assertEquals(typeof firstPrivilegeGrant?.grantedAt, "string");

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-read",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "read_file",
          args: { path: "note.txt" },
          taskId: submitted.id,
        },
      });

      const readReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "tool_response" &&
          message.to === "agent-beta" &&
          message.id === "tool-read",
      )) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(readReply.payload.success, true);
      assertEquals(executedTools, ["read_file"]);

      persisted = await broker.getTask({ taskId: submitted.id });
      privilegeGrants = ((persisted?.metadata?.broker as
        | { privilegeElevationGrants?: unknown[] }
        | undefined)?.privilegeElevationGrants) ?? [];
      assertEquals(
        privilegeGrants.length,
        1,
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-write-other",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "other.txt", content: "nope" },
          taskId: submitted.id,
        },
      });

      const otherDeniedReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "error" &&
          message.to === "agent-beta" &&
          message.id === "tool-write-other",
      )) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(
        otherDeniedReply.payload.code,
        "PRIVILEGE_ELEVATION_REQUIRED",
      );
      assertEquals(executedTools, ["read_file"]);

      persisted = await broker.getTask({ taskId: submitted.id });
      privilegeGrants = ((persisted?.metadata?.broker as
        | { privilegeElevationGrants?: unknown[] }
        | undefined)?.privilegeElevationGrants) ?? [];
      assertEquals(
        privilegeGrants.length,
        1,
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-write-1",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hello" },
          taskId: submitted.id,
        },
      });

      const writeReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "tool_response" &&
          message.to === "agent-beta" &&
          message.id === "tool-write-1",
      )) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(writeReply.payload.success, true);
      assertEquals(executedTools, ["read_file", "write_file"]);

      persisted = await broker.getTask({ taskId: submitted.id });
      privilegeGrants = ((persisted?.metadata?.broker as
        | { privilegeElevationGrants?: unknown[] }
        | undefined)?.privilegeElevationGrants) ?? [];
      assertEquals(
        privilegeGrants.length,
        0,
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-write-2",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "note.txt", content: "hello again" },
          taskId: submitted.id,
        },
      });

      const deniedReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "error" &&
          message.to === "agent-beta" &&
          message.id === "tool-write-2",
      )) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(deniedReply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer applies net privilege grants only to matching hosts",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      await kv.set(["agents", "agent-beta", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
        },
      });

      const queueMessages = createQueueCollector(kv);
      const executedUrls: string[] = [];
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: (request) => {
            executedUrls.push(String(request.args.url));
            return Promise.resolve({ success: true, output: "ok" });
          },
          resolveToolPermissions: (tool) => {
            switch (tool) {
              case "web_fetch":
                return ["net"];
              default:
                return [];
            }
          },
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-net-grant",
        taskMessage: createMessage("Fetch api.example.com"),
      });

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "net", hosts: ["api.example.com"] }],
            scope: "once",
            prompt: "Need temporary network access",
          }),
        },
      });

      await broker.continueAgentTask("agent-alpha", {
        taskId: submitted.id,
        continuationMessage: createMessage("Grant net once"),
        metadata: createResumePayloadMetadata({
          kind: "privilege-elevation",
          approved: true,
        }),
      });

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-net-other",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "web_fetch",
          args: { url: "https://other.example.com/page" },
          taskId: submitted.id,
        },
      });

      const otherHostDenied = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "error" &&
          message.to === "agent-beta" &&
          message.id === "tool-net-other",
      )) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(
        otherHostDenied.payload.code,
        "PRIVILEGE_ELEVATION_REQUIRED",
      );
      assertEquals(executedUrls, []);

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-net-allowed",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "web_fetch",
          args: { url: "https://api.example.com/page" },
          taskId: submitted.id,
        },
      });

      const allowedHostReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "tool_response" &&
          message.to === "agent-beta" &&
          message.id === "tool-net-allowed",
      )) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(allowedHostReply.payload.success, true);
      assertEquals(executedUrls, ["https://api.example.com/page"]);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer applies session-scoped privilege grants across tasks sharing a context",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      await kv.set(["agents", "agent-beta", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
        },
      });

      const queueMessages = createQueueCollector(kv);
      const executedTools: string[] = [];
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: (request) => {
            executedTools.push(request.tool);
            return Promise.resolve({ success: true, output: "ok" });
          },
          resolveToolPermissions: (tool) => {
            switch (tool) {
              case "write_file":
                return ["write"];
              default:
                return [];
            }
          },
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });

      const firstTask = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-session-grant-1",
        contextId: "ctx-session-grant",
        taskMessage: createMessage("Task one"),
      });

      await kv.set(["a2a_tasks", firstTask.id], {
        ...firstTask,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["session.txt"] }],
            scope: "session",
            prompt: "Need session write access",
          }),
        },
      });

      await broker.continueAgentTask("agent-alpha", {
        taskId: firstTask.id,
        continuationMessage: createMessage("Grant write for session"),
        metadata: createResumePayloadMetadata({
          kind: "privilege-elevation",
          approved: true,
          scope: "session",
        }),
      });

      const secondTask = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-session-grant-2",
        contextId: "ctx-session-grant",
        taskMessage: createMessage("Task two"),
      });

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-session-write",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "session.txt", content: "hello" },
          taskId: secondTask.id,
          contextId: "ctx-session-grant",
        },
      });

      const allowedReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "tool_response" &&
          message.to === "agent-beta" &&
          message.id === "tool-session-write",
      )) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(allowedReply.payload.success, true);
      assertEquals(executedTools, ["write_file"]);

      const thirdTask = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-session-grant-3",
        contextId: "ctx-other-session",
        taskMessage: createMessage("Task three"),
      });

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-session-write-denied",
        from: "agent-beta",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "session.txt", content: "hello" },
          taskId: thirdTask.id,
          contextId: "ctx-other-session",
        },
      });

      const deniedReply = (await waitForCollectedMessage(
        queueMessages,
        (message) =>
          message.type === "error" &&
          message.to === "agent-beta" &&
          message.id === "tool-session-write-denied",
      )) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(deniedReply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer does not leak session-scoped privilege grants across agents sharing a context",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedAgentEndpoint(kv, "agent-beta");
      await seedAgentEndpoint(kv, "agent-gamma");
      await kv.set(["agents", "agent-alpha", "config"], {
        peers: ["agent-beta", "agent-gamma"],
      });
      await kv.set(["agents", "agent-beta", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
        },
      });
      await kv.set(["agents", "agent-gamma", "config"], {
        acceptFrom: ["agent-alpha"],
        sandbox: {
          allowedPermissions: ["read"],
        },
      });

      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "ok" }),
          resolveToolPermissions: (tool) => {
            switch (tool) {
              case "write_file":
                return ["write"];
              default:
                return [];
            }
          },
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        metrics: new MetricsCollector(kv),
      });

      const firstTask = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-session-grant-beta",
        contextId: "ctx-shared-session-grant",
        taskMessage: createMessage("Task one"),
      });

      await kv.set(["a2a_tasks", firstTask.id], {
        ...firstTask,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["session.txt"] }],
            scope: "session",
            prompt: "Need session write access",
          }),
        },
      });

      await broker.continueAgentTask("agent-alpha", {
        taskId: firstTask.id,
        continuationMessage: createMessage("Grant write for session"),
        metadata: createResumePayloadMetadata({
          kind: "privilege-elevation",
          approved: true,
          scope: "session",
        }),
      });

      const secondTask = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-gamma",
        taskId: "task-session-grant-gamma",
        contextId: "ctx-shared-session-grant",
        taskMessage: createMessage("Task two"),
      });

      const replyPromise = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "error" &&
          message.id === "tool-session-write-cross-agent",
      );
      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-session-write-cross-agent",
        from: "agent-gamma",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "write_file",
          args: { path: "session.txt", content: "hello" },
          taskId: secondTask.id,
          contextId: "ctx-shared-session-grant",
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "error" }
      >;
      assertEquals(reply.payload.code, "PRIVILEGE_ELEVATION_REQUIRED");
      assertEquals(reply.payload.context?.denied, ["write"]);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer rejects privilege-elevation resumes that broaden requested grants or scope",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      const broker = createTestBroker(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });

      const submitted = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-invalid-privilege-resume",
        contextId: "ctx-invalid-privilege-resume",
        taskMessage: createMessage("Need temporary write access"),
      });

      await kv.set(["a2a_tasks", submitted.id], {
        ...submitted,
        status: {
          state: "INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          metadata: createAwaitedInputMetadata({
            kind: "privilege-elevation",
            grants: [{ permission: "write", paths: ["docs"] }],
            scope: "task",
            prompt: "Need write access under docs",
          }),
        },
      });

      await assertRejects(
        () =>
          broker.continueAgentTask("agent-alpha", {
            taskId: submitted.id,
            continuationMessage: createMessage("Broaden it"),
            metadata: createResumePayloadMetadata({
              kind: "privilege-elevation",
              approved: true,
              grants: [{ permission: "write", paths: ["*"] }],
            }),
          }),
        DenoClawError,
        "Resume with the requested privilege grants or a narrower subset",
      );

      await assertRejects(
        () =>
          broker.continueAgentTask("agent-alpha", {
            taskId: submitted.id,
            continuationMessage: createMessage("Make it session-wide"),
            metadata: createResumePayloadMetadata({
              kind: "privilege-elevation",
              approved: true,
              scope: "session",
            }),
          }),
        DenoClawError,
        "Resume with the requested privilege scope or a narrower scope",
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer returns EXEC_POLICY_DENIED for broker-backed shell tasks outside policy without reaching sandbox",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedAgentEndpoint(kv, "agent-alpha");
      await kv.set(["agents", "agent-alpha", "config"], {
        sandbox: {
          allowedPermissions: ["run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["git"],
          },
        },
      });

      let sandboxCalls = 0;
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: () => {
            sandboxCalls++;
            return Promise.resolve({ success: true, output: "" });
          },
          resolveToolPermissions: () => ["run"],
          checkExecPolicy: () => ({
            allowed: false,
            reason: "not-in-allowlist",
            binary: "curl",
            recovery: "Add 'curl' to execPolicy.allowedCommands",
          }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });

      const replyPromise = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "tool_response" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-1",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "shell",
          args: { command: "curl https://example.com", dry_run: false },
          taskId: "task-policy-denied-no-sandbox",
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(reply.payload.error?.code, "EXEC_POLICY_DENIED");
      assertEquals(reply.payload.error?.context, {
        command: "curl https://example.com",
        binary: "curl",
        reason: "not-in-allowlist",
      });
      assertEquals(
        reply.payload.error?.recovery,
        "Add 'curl' to execPolicy.allowedCommands",
      );
      assertEquals(sandboxCalls, 0);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer returns EXEC_POLICY_DENIED for broker-backed shell tasks blocked by policy",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedAgentEndpoint(kv, "agent-alpha");
      await kv.set(["agents", "agent-alpha", "config"], {
        sandbox: {
          allowedPermissions: ["run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["git"],
          },
        },
      });

      let sandboxCalls = 0;
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: () => {
            sandboxCalls++;
            return Promise.resolve({ success: true, output: "" });
          },
          resolveToolPermissions: () => ["run"],
          checkExecPolicy: () => ({
            allowed: false,
            reason: "not-in-allowlist",
            binary: "curl",
            recovery: "Add 'curl' to execPolicy.allowedCommands",
          }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });

      const replyPromise = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "tool_response" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-policy-denied",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "shell",
          args: { command: "curl https://example.com", dry_run: false },
          taskId: "task-policy-denied",
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(reply.payload.error?.code, "EXEC_POLICY_DENIED");
      assertEquals(reply.payload.error?.context, {
        command: "curl https://example.com",
        binary: "curl",
        reason: "not-in-allowlist",
      });
      assertEquals(
        reply.payload.error?.recovery,
        "Add 'curl' to execPolicy.allowedCommands",
      );
      assertEquals(sandboxCalls, 0);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer runs exec-policy preflight before routing shell tools to a tunnel",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedAgentEndpoint(kv, "agent-alpha");
      await kv.set(["agents", "agent-alpha", "config"], {
        sandbox: {
          allowedPermissions: ["run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["git"],
          },
        },
      });

      const tunnelRegistry = new TunnelRegistry();
      const tunnelMessages: BrokerMessage[] = [];
      const fakeTunnel = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send(raw: string) {
          tunnelMessages.push(JSON.parse(raw) as BrokerMessage);
        },
        close() {},
      } as unknown as WebSocket;
      tunnelRegistry.register("relay-shell", fakeTunnel, {
        tunnelId: "relay-shell",
        type: "local",
        tools: ["shell"],
        allowedAgents: [],
      });

      let executeCalls = 0;
      const broker = createTestBroker(createConfig(), {
        kv,
        tunnelRegistry,
        toolExecution: {
          executeTool: () => {
            executeCalls++;
            return Promise.resolve({ success: true, output: "" });
          },
          resolveToolPermissions: () => ["run"],
          checkExecPolicy: () => ({
            allowed: false,
            reason: "not-in-allowlist",
            binary: "curl",
          }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });

      const replyPromise = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "tool_response" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-tunnel-preflight",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "shell",
          args: { command: "curl https://example.com", dry_run: false },
          taskId: "task-tunnel-preflight",
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(reply.payload.error?.code, "EXEC_POLICY_DENIED");
      assertEquals(tunnelMessages.length, 0);
      assertEquals(executeCalls, 0);

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer forwards resolved shell mode to tunnel execution",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedAgentEndpoint(kv, "agent-alpha");
      await kv.set(["agents", "agent-alpha", "config"], {
        sandbox: {
          allowedPermissions: ["run"],
          execPolicy: {
            security: "full",
          },
          shell: {
            mode: "system-shell",
          },
        },
      });

      const tunnelRegistry = new TunnelRegistry();
      const tunnelMessages: BrokerMessage[] = [];
      const fakeTunnel = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send(raw: string) {
          tunnelMessages.push(JSON.parse(raw) as BrokerMessage);
        },
        close() {},
      } as unknown as WebSocket;
      tunnelRegistry.register("relay-shell-mode", fakeTunnel, {
        tunnelId: "relay-shell-mode",
        type: "local",
        tools: ["shell"],
        allowedAgents: [],
      });

      const broker = new BrokerServer(createConfig(), {
        kv,
        tunnelRegistry,
        toolExecution: {
          executeTool: () => Promise.resolve({ success: true, output: "" }),
          resolveToolPermissions: () => ["run"],
          checkExecPolicy: (_command, _policy, shell) => ({
            allowed: true,
            binary: shell?.mode === "system-shell" ? "sh" : "echo",
          }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-shell-mode",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "shell",
          args: { command: "echo hello | tr a-z A-Z", dry_run: false },
        },
      });

      assertEquals(tunnelMessages.length, 1);
      assertEquals(
        (
          tunnelMessages[0] as Extract<BrokerMessage, { type: "tool_request" }>
        ).payload.execution?.shell,
        { mode: "system-shell" },
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer forwards execution context for broker-backed tool execution",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await seedAgentEndpoint(kv, "agent-alpha");
      await kv.set(["agents", "agent-alpha", "config"], {
        sandbox: {
          allowedPermissions: ["run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["echo"],
          },
        },
      });

      let capturedRequest: Record<string, unknown> | undefined;
      const broker = createTestBroker(createConfig(), {
        kv,
        toolExecution: {
          executeTool: (request) => {
            capturedRequest = request as unknown as Record<string, unknown>;
            return Promise.resolve({ success: true, output: "ok" });
          },
          resolveToolPermissions: () => ["run"],
          checkExecPolicy: () => ({ allowed: true, binary: "echo" }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });

      const replyPromise = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "tool_response" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-context",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "shell",
          args: { command: "echo hi", dry_run: false },
          taskId: "task-context",
          contextId: "ctx-context",
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(reply.payload.success, true);
      assertEquals(capturedRequest?.executionContext, {
        agentId: "agent-alpha",
        taskId: "task-context",
        contextId: "ctx-context",
        ownershipScope: "context",
      });

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer keeps workspace KV file tools broker-owned in deploy mode",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const previousDeploymentId = Deno.env.get("DENO_DEPLOYMENT_ID");

    try {
      Deno.env.set("DENO_DEPLOYMENT_ID", "deploy-test");
      await seedAgentEndpoint(kv, "agent-alpha");
      await kv.set(["agents", "agent-alpha", "config"], {
        sandbox: {
          allowedPermissions: ["read"],
        },
      });

      const tunnelRegistry = new TunnelRegistry();
      const tunnelMessages: BrokerMessage[] = [];
      const fakeTunnel = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send(raw: string) {
          tunnelMessages.push(JSON.parse(raw) as BrokerMessage);
        },
        close() {},
      } as unknown as WebSocket;
      tunnelRegistry.register("relay-read", fakeTunnel, {
        tunnelId: "relay-read",
        type: "local",
        tools: ["read_file"],
        allowedAgents: [],
      });

      let capturedRequest: Record<string, unknown> | undefined;
      const broker = createTestBroker(createConfig(), {
        kv,
        tunnelRegistry,
        toolExecution: {
          executeTool: (request) => {
            capturedRequest = request as unknown as Record<string, unknown>;
            return Promise.resolve({ success: true, output: "from-kv" });
          },
          resolveToolPermissions: () => ["read"],
          checkExecPolicy: () => ({ allowed: true }),
          getToolPermissions: () => ({}),
        },
        // deno-lint-ignore no-explicit-any
        metrics: { recordToolCall: async () => {} } as any,
      });

      const replyPromise = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "tool_response" && message.to === "agent-alpha",
      );

      await (
        broker as unknown as {
          handleToolRequest(
            msg: Extract<BrokerMessage, { type: "tool_request" }>,
          ): Promise<void>;
        }
      ).handleToolRequest({
        id: "tool-req-workspace-kv",
        from: "agent-alpha",
        to: "broker",
        type: "tool_request",
        timestamp: new Date().toISOString(),
        payload: {
          tool: "read_file",
          args: { path: "memories/project.md" },
        },
      });

      const reply = (await replyPromise) as Extract<
        BrokerMessage,
        { type: "tool_response" }
      >;
      assertEquals(reply.payload.success, true);
      assertEquals(tunnelMessages.length, 0);
      assertEquals(capturedRequest?.toolsConfig, {
        agentId: "agent-alpha",
        workspaceBackend: "kv",
      });

      await broker.stop();
    } finally {
      if (previousDeploymentId) {
        Deno.env.set("DENO_DEPLOYMENT_ID", previousDeploymentId);
      } else {
        Deno.env.delete("DENO_DEPLOYMENT_ID");
      }
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "Broker tunnel protocol negotiation prefers the canonical subprotocol",
  () => {
    assertEquals(
      getAcceptedTunnelProtocol(`${DENOCLAW_TUNNEL_PROTOCOL}, legacy-protocol`),
      DENOCLAW_TUNNEL_PROTOCOL,
    );
    assertEquals(getAcceptedTunnelProtocol("legacy-protocol"), undefined);
    assertEquals(getAcceptedTunnelProtocol(null), undefined);
  },
);

Deno.test(
  "BrokerServer rejects agent socket upgrades without the canonical subprotocol",
  async () => {
    const broker = new BrokerServer(createConfig(), {
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    try {
      const res = await (
        broker as unknown as {
          handleAgentSocketUpgrade(req: Request): Promise<Response>;
        }
      ).handleAgentSocketUpgrade(
        new Request("http://localhost/agent/socket", {
          headers: {
            upgrade: "websocket",
          },
        }),
      );

      assertEquals(res.status, 426);
      assertEquals(
        await res.text(),
        `Expected WebSocket subprotocol: ${DENOCLAW_AGENT_PROTOCOL}`,
      );
    } finally {
      await broker.stop();
    }
  },
);

Deno.test(
  "BrokerServer rejects agent socket upgrades without Authorization when broker auth is configured",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "static-token");

    try {
      const res = await (
        broker as unknown as {
          handleAgentSocketUpgrade(req: Request): Promise<Response>;
        }
      ).handleAgentSocketUpgrade(
        new Request("http://localhost/agent/socket", {
          headers: {
            upgrade: "websocket",
            "sec-websocket-protocol": DENOCLAW_AGENT_PROTOCOL,
          },
        }),
      );

      assertEquals(res.status, 401);
      assertEquals(await res.json(), {
        error: {
          code: "UNAUTHORIZED",
          recovery: "Add Authorization: Bearer <token> header",
        },
      });
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer /agents/register persists endpoint and config",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "register-secret");

    try {
      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request("http://localhost/agents/register", {
          method: "POST",
          headers: {
            authorization: "Bearer register-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agentId: "agent-beta",
            endpoint: "https://agent-beta.example",
            config: {
              model: "test/model",
              peers: ["agent-alpha"],
              acceptFrom: ["agent-alpha"],
            },
          }),
        }),
      );

      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, agentId: "agent-beta" });

      const endpoint = await kv.get<string>([
        "agents",
        "agent-beta",
        "endpoint",
      ]);
      assertEquals(endpoint.value, "https://agent-beta.example");

      const agentConfig = await kv.get<{ model?: string; peers?: string[] }>([
        "agents",
        "agent-beta",
        "config",
      ]);
      assertEquals(agentConfig.value?.model, "test/model");
      assertEquals(agentConfig.value?.peers, ["agent-alpha"]);
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer GET /agents/:id/config returns stored agent config",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "config-secret");

    try {
      await kv.set(["agents", "agent-beta", "config"], {
        model: "test/model",
        peers: ["agent-alpha"],
      });

      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request("http://localhost/agents/agent-beta/config", {
          headers: {
            authorization: "Bearer config-secret",
          },
        }),
      );

      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        agentId: "agent-beta",
        config: {
          model: "test/model",
          peers: ["agent-alpha"],
        },
      });
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.submitAgentTask posts to registered agent endpoint when no live route is available",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "wake-secret");
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      fetchCalls.push({ url, init });
      return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
    }) as typeof fetch;

    try {
      await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
      await kv.set(
        ["agents", "agent-beta", "endpoint"],
        "https://agent-beta.example",
      );

      const task = await broker.submitAgentTask("agent-alpha", {
        targetAgent: "agent-beta",
        taskId: "task-http",
        contextId: "ctx-http",
        taskMessage: createMessage("Wake up and summarize this"),
      });

      assertEquals(task.id, "task-http");
      assertEquals(fetchCalls.length, 1);
      assertEquals(fetchCalls[0].url, "https://agent-beta.example/tasks");
      assertEquals(fetchCalls[0].init?.headers, {
        "content-type": "application/json",
        authorization: "Bearer wake-secret",
      });

      const body = JSON.parse(
        String(fetchCalls[0].init?.body),
      ) as Extract<BrokerMessage, { type: "task_submit" }>;
      assertEquals(body.type, "task_submit");
      assertEquals(body.to, "agent-beta");
      if (body.type !== "task_submit") {
        throw new Error(`Unexpected broker message type: ${body.type}`);
      }
      assertEquals(body.payload.taskId, "task-http");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer /ingress/messages persists a channel-backed task and routes canonical task_submit",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const { messages: socketMessages, socket } = createSocketCollector();
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "ingress-secret");

    try {
      registerConnectedAgentSocket(broker, "agent-beta", socket);

      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request("http://localhost/ingress/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer ingress-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              id: "telegram-msg-1",
              sessionId: "telegram-123",
              userId: "123",
              content: "Bonjour broker",
              channelType: "telegram",
              timestamp: new Date().toISOString(),
              address: {
                channelType: "telegram",
                userId: "123",
                roomId: "123",
              },
              metadata: {
                username: "alice",
              },
            },
            route: {
              agentId: "agent-beta",
              taskId: "channel-task-1",
            },
          }),
        }),
      );

      assertEquals(res.status, 200);
      const body = await res.json() as { task: Task };
      assertEquals(body.task.id, "channel-task-1");
      assertEquals(body.task.contextId, "telegram-123");
      assertEquals(body.task.metadata?.broker, {
        submittedBy: "channel:telegram",
        delivery: "direct",
        targetAgent: "agent-beta",
        targetAgentIds: ["agent-beta"],
        request: {
          channelMessage: {
            username: "alice",
          },
        },
        channel: {
          channelType: "telegram",
          sessionId: "telegram-123",
          userId: "123",
          address: {
            channelType: "telegram",
            userId: "123",
            roomId: "123",
          },
        },
      });

      assertEquals(socketMessages.length, 1);
      const forwarded = socketMessages[0] as Extract<
        BrokerMessage,
        { type: "task_submit" }
      >;
      assertEquals(forwarded.payload.targetAgent, "agent-beta");
      assertEquals(forwarded.from, "channel:telegram");
      assertEquals(forwarded.payload.taskMessage?.parts[0], {
        kind: "text",
        text: "Bonjour broker",
      });
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer /ingress/messages accepts a direct route plan payload",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const { messages: socketMessages, socket } = createSocketCollector();
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "ingress-secret");

    try {
      registerConnectedAgentSocket(broker, "agent-beta", socket);

      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request("http://localhost/ingress/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer ingress-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              id: "telegram-msg-plan-1",
              sessionId: "telegram-plan-123",
              userId: "123",
              content: "Bonjour broker plan",
              channelType: "telegram",
              timestamp: new Date().toISOString(),
              address: {
                channelType: "telegram",
                userId: "123",
                roomId: "123",
              },
            },
            route: {
              delivery: "direct",
              targetAgentIds: ["agent-beta"],
              primaryAgentId: "agent-beta",
              metadata: {
                source: "route-plan",
              },
            },
            taskId: "channel-task-plan-1",
          }),
        }),
      );

      assertEquals(res.status, 200);
      const body = await res.json() as { task: Task };
      assertEquals(body.task.id, "channel-task-plan-1");
      assertEquals(body.task.contextId, "telegram-plan-123");
      assertEquals(body.task.metadata?.broker, {
        submittedBy: "channel:telegram",
        delivery: "direct",
        targetAgent: "agent-beta",
        targetAgentIds: ["agent-beta"],
        request: {
          ingress: {
            source: "route-plan",
          },
        },
        channel: {
          channelType: "telegram",
          sessionId: "telegram-plan-123",
          userId: "123",
          address: {
            channelType: "telegram",
            userId: "123",
            roomId: "123",
          },
        },
      });

      assertEquals(socketMessages.length, 1);
      const forwarded = socketMessages[0] as Extract<
        BrokerMessage,
        { type: "task_submit" }
      >;
      assertEquals(forwarded.payload.targetAgent, "agent-beta");
      assertEquals(forwarded.from, "channel:telegram");
      const forwardedMetadata = forwarded.payload.metadata as {
        source?: string;
        channel?: {
          channelType?: string;
          sessionId?: string;
          userId?: string;
          address?: Record<string, unknown>;
          timestamp?: string;
        };
      };
      assertEquals(forwardedMetadata.source, "route-plan");
      assertEquals(forwardedMetadata.channel?.channelType, "telegram");
      assertEquals(forwardedMetadata.channel?.sessionId, "telegram-plan-123");
      assertEquals(forwardedMetadata.channel?.userId, "123");
      assertEquals(forwardedMetadata.channel?.address, {
        channelType: "telegram",
        userId: "123",
        roomId: "123",
      });
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer /ingress/messages accepts broadcast route plan payloads and fans out agent tasks",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const alphaSocket = createSocketCollector();
    const betaSocket = createSocketCollector();
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "ingress-secret");

    try {
      registerConnectedAgentSocket(broker, "agent-alpha", alphaSocket.socket);
      registerConnectedAgentSocket(broker, "agent-beta", betaSocket.socket);
      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request("http://localhost/ingress/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer ingress-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              id: "telegram-msg-plan-broadcast-1",
              sessionId: "telegram-plan-broadcast-123",
              userId: "123",
              content: "Bonjour broker broadcast",
              channelType: "telegram",
              timestamp: new Date().toISOString(),
              address: {
                channelType: "telegram",
                userId: "123",
                roomId: "123",
              },
            },
            route: {
              delivery: "broadcast",
              targetAgentIds: ["agent-alpha", "agent-beta"],
            },
            taskId: "channel-task-plan-broadcast-1",
          }),
        }),
      );

      assertEquals(res.status, 200);
      const body = await res.json() as { task: Task };
      assertEquals(body.task.id, "channel-task-plan-broadcast-1");
      assertEquals(body.task.contextId, "telegram-plan-broadcast-123");
      assertEquals(body.task.metadata?.broker, {
        submittedBy: "channel:telegram",
        delivery: "broadcast",
        targetAgentIds: ["agent-alpha", "agent-beta"],
        channel: {
          channelType: "telegram",
          sessionId: "telegram-plan-broadcast-123",
          userId: "123",
          address: {
            channelType: "telegram",
            userId: "123",
            roomId: "123",
          },
        },
        shared: {
          agentTasks: [
            {
              agentId: "agent-alpha",
              taskId: "channel-task-plan-broadcast-1:1:agent-alpha",
              state: "SUBMITTED",
            },
            {
              agentId: "agent-beta",
              taskId: "channel-task-plan-broadcast-1:2:agent-beta",
              state: "SUBMITTED",
            },
          ],
        },
      });
      assertEquals(body.task.metadata?.broadcast, {
        delivery: "broadcast",
        targetAgentIds: ["agent-alpha", "agent-beta"],
        agentTasks: [
          {
            agentId: "agent-alpha",
            agentTaskId: "channel-task-plan-broadcast-1:1:agent-alpha",
            state: "SUBMITTED",
          },
          {
            agentId: "agent-beta",
            agentTaskId: "channel-task-plan-broadcast-1:2:agent-beta",
            state: "SUBMITTED",
          },
        ],
      });

      assertEquals(alphaSocket.messages.length, 1);
      assertEquals(betaSocket.messages.length, 1);
      const alphaForwarded = alphaSocket.messages[0] as Extract<
        BrokerMessage,
        { type: "task_submit" }
      >;
      const betaForwarded = betaSocket.messages[0] as Extract<
        BrokerMessage,
        { type: "task_submit" }
      >;
      assertEquals(
        alphaForwarded.payload.taskId,
        "channel-task-plan-broadcast-1:1:agent-alpha",
      );
      assertEquals(
        betaForwarded.payload.taskId,
        "channel-task-plan-broadcast-1:2:agent-beta",
      );
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.recordTaskResult aggregates broadcast agent task results onto the shared ingress task",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const broker = new BrokerServer(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      attachConnectedAgentInbox(broker, "agent-alpha");
      attachConnectedAgentInbox(broker, "agent-beta");

      const sharedTask = await broker.submitChannelMessage(
        {
          id: "discord-msg-1",
          sessionId: "discord-room-1",
          userId: "user-1",
          content: "shared prompt",
          channelType: "discord",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "discord",
            roomId: "room-1",
            userId: "user-1",
          },
        },
        {
          routePlan: createBroadcastChannelRoutePlan([
            "agent-alpha",
            "agent-beta",
          ]),
          taskId: "broadcast-task-1",
        },
      );

      const agentTaskRefs = bodyBrokerMetadata(sharedTask).shared?.agentTasks ??
        [];
      assertEquals(
        agentTaskRefs.map((agentTask) => agentTask.taskId),
        [
          "broadcast-task-1:1:agent-alpha",
          "broadcast-task-1:2:agent-beta",
        ],
      );

      const alphaTask = await broker.getTask({
        taskId: agentTaskRefs[0].taskId,
      });
      const betaTask = await broker.getTask({
        taskId: agentTaskRefs[1].taskId,
      });
      assertExists(alphaTask);
      assertExists(betaTask);

      const alphaRecorded = await broker.recordTaskResult("agent-alpha", {
        task: {
          ...alphaTask,
          status: {
            state: "COMPLETED",
            timestamp: new Date().toISOString(),
            message: {
              messageId: crypto.randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: "Alpha done" }],
            },
          },
          artifacts: [
            {
              artifactId: `${alphaTask.id}:result`,
              name: "result",
              parts: [{ kind: "text", text: "Alpha done" }],
            },
          ],
        },
      });
      assertExists(alphaRecorded);
      assertEquals(alphaRecorded?.id, "broadcast-task-1:1:agent-alpha");

      const sharedTaskWhileBetaPending = await broker.getTask({
        taskId: "broadcast-task-1",
      });
      assertExists(sharedTaskWhileBetaPending);
      assertEquals(sharedTaskWhileBetaPending?.status.state, "WORKING");

      await broker.recordTaskResult("agent-beta", {
        task: {
          ...betaTask,
          status: {
            state: "REJECTED",
            timestamp: new Date().toISOString(),
            message: {
              messageId: crypto.randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: "Beta refused" }],
            },
          },
        },
      });

      const completedSharedTask = await broker.getTask({
        taskId: "broadcast-task-1",
      });
      assertExists(completedSharedTask);
      assertEquals(completedSharedTask?.status.state, "COMPLETED");
      assertEquals(completedSharedTask?.metadata?.broadcast, {
        delivery: "broadcast",
        targetAgentIds: ["agent-alpha", "agent-beta"],
        agentTasks: [
          {
            agentId: "agent-alpha",
            agentTaskId: "broadcast-task-1:1:agent-alpha",
            state: "COMPLETED",
          },
          {
            agentId: "agent-beta",
            agentTaskId: "broadcast-task-1:2:agent-beta",
            state: "REJECTED",
          },
        ],
      });
      assertEquals(
        completedSharedTask?.artifacts.at(-1)?.parts[0],
        {
          kind: "text",
          text: "[agent-alpha] Alpha done\n\n[agent-beta] Beta refused",
        },
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer.submitChannelMessage keeps broadcast agent tasks consistent when one target route is unavailable",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const broker = new BrokerServer(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      attachConnectedAgentInbox(broker, "agent-alpha");

      const sharedTask = await broker.submitChannelMessage(
        {
          id: "discord-msg-partial-route-1",
          sessionId: "discord-room-partial-route-1",
          userId: "user-1",
          content: "shared prompt",
          channelType: "discord",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "discord",
            roomId: "room-partial-route-1",
            userId: "user-1",
          },
        },
        {
          routePlan: createBroadcastChannelRoutePlan([
            "agent-alpha",
            "agent-beta",
          ]),
          taskId: "broadcast-partial-route-1",
        },
      );

      const sharedBrokerMetadata = bodyBrokerMetadata(sharedTask);
      assertEquals(sharedBrokerMetadata.shared?.agentTasks, [
        {
          agentId: "agent-alpha",
          taskId: "broadcast-partial-route-1:1:agent-alpha",
          state: "SUBMITTED",
        },
        {
          agentId: "agent-beta",
          taskId: "broadcast-partial-route-1:2:agent-beta",
          state: "FAILED",
        },
      ]);

      const failedAgentTask = await broker.getTask({
        taskId: "broadcast-partial-route-1:2:agent-beta",
      });
      assertExists(failedAgentTask);
      assertEquals(failedAgentTask.status.state, "FAILED");
      assertEquals(
        failedAgentTask.status.message?.parts[0],
        {
          kind: "text",
          text:
            "Failed to route shared ingress to agent-beta: AGENT_ROUTE_UNAVAILABLE",
        },
      );

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer /ingress/tasks/:id/continue routes canonical task_continue for the same channel session",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const originalFetch = globalThis.fetch;
    const { calls, fetch } = createAgentEndpointFetchCollector();
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "ingress-secret");

    try {
      await kv.set(
        ["agents", "agent-beta", "endpoint"],
        "https://agent-beta.example",
      );
      globalThis.fetch = fetch;
      const initialMessage = {
        id: "telegram-msg-2",
        sessionId: "telegram-999",
        userId: "999",
        content: "Need follow-up",
        channelType: "telegram",
        timestamp: new Date().toISOString(),
        address: {
          channelType: "telegram",
          userId: "999",
          roomId: "999",
        },
      };

      const submitted = await broker.submitChannelMessage(
        initialMessage,
        {
          routePlan: createDirectChannelRoutePlan("agent-beta"),
          taskId: "channel-task-2",
        },
      );

      await broker.recordTaskResult("agent-beta", {
        task: {
          ...submitted,
          status: {
            state: "INPUT_REQUIRED",
            timestamp: new Date().toISOString(),
          },
        },
      });

      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request("http://localhost/ingress/tasks/channel-task-2/continue", {
          method: "POST",
          headers: {
            authorization: "Bearer ingress-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              ...initialMessage,
              id: "telegram-msg-3",
              content: "Approved, continue",
            },
          }),
        }),
      );

      assertEquals(res.status, 200);
      const body = await res.json() as { task: Task };
      assertEquals(body.task.id, "channel-task-2");
      assertEquals(body.task.status.state, "INPUT_REQUIRED");

      assertEquals(calls.length, 2);
      const forwarded = JSON.parse(
        String(calls[1].init?.body),
      ) as Extract<BrokerMessage, { type: "task_continue" }>;
      assertEquals(forwarded.from, "channel:telegram");
      assertEquals(forwarded.payload.taskId, "channel-task-2");
      assertEquals(forwarded.payload.continuationMessage?.parts[0], {
        kind: "text",
        text: "Approved, continue",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer /ingress/tasks/:id/continue fans out continuation to paused broadcast agent tasks",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "ingress-secret");

    try {
      const alphaInbox = attachConnectedAgentInbox(broker, "agent-alpha");
      attachConnectedAgentInbox(broker, "agent-beta");
      const sharedTask = await broker.submitChannelMessage(
        {
          id: "discord-msg-continue-1",
          sessionId: "discord-session-continue-1",
          userId: "user-1",
          content: "shared prompt",
          channelType: "discord",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "discord",
            roomId: "room-continue-1",
            userId: "user-1",
          },
        },
        {
          routePlan: createBroadcastChannelRoutePlan([
            "agent-alpha",
            "agent-beta",
          ]),
          taskId: "broadcast-continue-task-1",
        },
      );

      const agentTaskRefs = bodyBrokerMetadata(sharedTask).shared?.agentTasks ??
        [];
      const pausedAgentTask = await broker.getTask({
        taskId: agentTaskRefs[0].taskId,
      });
      assertExists(pausedAgentTask);

      await broker.recordTaskResult("agent-alpha", {
        task: {
          ...pausedAgentTask,
          status: {
            state: "INPUT_REQUIRED",
            timestamp: new Date().toISOString(),
            metadata: createAwaitedInputMetadata({
              kind: "privilege-elevation",
              grants: [{ permission: "write", paths: ["note.txt"] }],
              scope: "once",
              prompt: "approve alpha?",
              command: "git status",
              binary: "git",
            }),
          },
        },
      });

      const res = await (
        broker as unknown as {
          handleHttpInner(req: Request): Promise<Response>;
        }
      ).handleHttpInner(
        new Request(
          "http://localhost/ingress/tasks/broadcast-continue-task-1/continue",
          {
            method: "POST",
            headers: {
              authorization: "Bearer ingress-secret",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              message: {
                id: "discord-msg-continue-2",
                sessionId: "discord-session-continue-1",
                userId: "user-1",
                content: "continue",
                channelType: "discord",
                timestamp: new Date().toISOString(),
                address: {
                  channelType: "discord",
                  roomId: "room-continue-1",
                  userId: "user-1",
                },
                metadata: {
                  resume: { kind: "privilege-elevation", approved: true },
                },
              },
            }),
          },
        ),
      );

      assertEquals(res.status, 200);
      const body = await res.json() as { task: Task };
      assertEquals(body.task.id, "broadcast-continue-task-1");
      assertEquals(body.task.status.state, "INPUT_REQUIRED");

      const forwarded = alphaInbox.at(-1) as Extract<
        BrokerMessage,
        { type: "task_continue" }
      >;
      assertEquals(forwarded.from, "channel:discord");
      assertEquals(forwarded.payload.taskId, agentTaskRefs[0].taskId);
      assertEquals(forwarded.payload.continuationMessage?.parts[0], {
        kind: "text",
        text: "continue",
      });
      assertEquals(forwarded.payload.metadata, {
        resume: { kind: "privilege-elevation", approved: true },
      });

      const updatedPausedAgentTask = await broker.getTask({
        taskId: agentTaskRefs[0].taskId,
      });
      assertExists(updatedPausedAgentTask);
      const privilegeGrants = bodyBrokerMetadata(updatedPausedAgentTask)
        .privilegeElevationGrants ?? [];
      const grantedResume = privilegeGrants[0];
      assertExists(grantedResume);
      assertEquals(grantedResume.kind, "privilege-elevation");
      assertEquals(grantedResume.scope, "once");
      assertEquals(grantedResume.grants, [
        { permission: "write", paths: ["note.txt"] },
      ]);
      assertEquals(grantedResume.source, "broker-resume");
      assertEquals(typeof grantedResume.grantedAt, "string");
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer rejects tunnel upgrades without the canonical subprotocol",
  async () => {
    const broker = new BrokerServer(createConfig(), {
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    try {
      const res = await (
        broker as unknown as {
          handleTunnelUpgrade(req: Request): Promise<Response>;
        }
      ).handleTunnelUpgrade(
        new Request("http://localhost/tunnel", {
          headers: {
            upgrade: "websocket",
          },
        }),
      );

      assertEquals(res.status, 426);
      assertEquals(
        await res.text(),
        `Expected WebSocket subprotocol: ${DENOCLAW_TUNNEL_PROTOCOL}`,
      );
    } finally {
      await broker.stop();
    }
  },
);

Deno.test(
  "BrokerServer rejects tunnel upgrades without Authorization bearer auth",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);

    try {
      const res = await (
        broker as unknown as {
          handleTunnelUpgrade(req: Request): Promise<Response>;
        }
      ).handleTunnelUpgrade(
        new Request("http://localhost/tunnel", {
          headers: {
            upgrade: "websocket",
            "sec-websocket-protocol": DENOCLAW_TUNNEL_PROTOCOL,
          },
        }),
      );

      assertEquals(res.status, 401);
      assertEquals(await res.json(), {
        error: {
          code: "UNAUTHORIZED",
          recovery:
            "Add Authorization: Bearer <invite-or-session-token> header",
        },
      });
    } finally {
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer tunnel auth does not fall back to static API tokens",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    (broker as unknown as { auth: AuthManager }).auth = new AuthManager(kv);
    const previousStaticToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "static-token");

    try {
      const res = await (
        broker as unknown as {
          handleTunnelUpgrade(req: Request): Promise<Response>;
        }
      ).handleTunnelUpgrade(
        new Request("http://localhost/tunnel", {
          headers: {
            upgrade: "websocket",
            "sec-websocket-protocol": DENOCLAW_TUNNEL_PROTOCOL,
            authorization: "Bearer static-token",
          },
        }),
      );

      assertEquals(res.status, 401);
      assertEquals(await res.json(), {
        error: {
          code: "AUTH_FAILED",
          recovery: "Reconnect with a valid tunnel invite or session token",
        },
      });
    } finally {
      if (previousStaticToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousStaticToken);
      }
      await broker.stop();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test("BrokerServer routeToTunnel rejects saturated tunnels", async () => {
  const broker = new BrokerServer(createConfig(), {
    // deno-lint-ignore no-explicit-any
    metrics: { recordAgentMessage: async () => {} } as any,
  });

  try {
    const saturatedSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: WS_BUFFERED_AMOUNT_HIGH_WATERMARK + 1,
      send: () => {
        throw new Error("send should not be called for saturated tunnel");
      },
    } as unknown as WebSocket;

    assertThrows(
      () =>
        (
          broker as unknown as {
            routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
          }
        ).routeToTunnel(saturatedSocket, {
          id: "msg-backpressure",
          from: "broker",
          to: "agent-beta",
          type: "task_result",
          payload: { task: null },
          timestamp: new Date().toISOString(),
        }),
      Error,
      "Tunnel is saturated",
    );
  } finally {
    await broker.stop();
  }
});

Deno.test(
  "BrokerServer federation identity endpoints support CRUD lifecycle",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const broker = new BrokerServer(createConfig(), {
        kv,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });

      const putResponse = await (
        broker as unknown as { handleHttp(req: Request): Promise<Response> }
      ).handleHttp(
        new Request("http://localhost/federation/identity", {
          ...withBrokerAuth({
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              brokerId: "broker-remote",
              instanceUrl: "https://remote.example.com",
              publicKeys: ["pub-1"],
              status: "trusted",
            }),
          }),
        }),
      );
      assertEquals(putResponse.status, 200);

      const getResponse = await (
        broker as unknown as { handleHttp(req: Request): Promise<Response> }
      ).handleHttp(
        new Request(
          "http://localhost/federation/identity?brokerId=broker-remote",
          withBrokerAuth(),
        ),
      );
      assertEquals(getResponse.status, 200);
      const one = await getResponse.json();
      assertEquals(one.brokerId, "broker-remote");
      assertEquals(one.status, "trusted");

      const listResponse = await (
        broker as unknown as { handleHttp(req: Request): Promise<Response> }
      ).handleHttp(
        new Request("http://localhost/federation/identities", withBrokerAuth()),
      );
      assertEquals(listResponse.status, 200);
      const all = await listResponse.json();
      assertEquals(all.length, 1);

      const deleteResponse = await (
        broker as unknown as { handleHttp(req: Request): Promise<Response> }
      ).handleHttp(
        new Request(
          "http://localhost/federation/identity?brokerId=broker-remote",
          withBrokerAuth({
            method: "DELETE",
          }),
        ),
      );
      assertEquals(deleteResponse.status, 200);

      const revokedResponse = await (
        broker as unknown as { handleHttp(req: Request): Promise<Response> }
      ).handleHttp(
        new Request(
          "http://localhost/federation/identity?brokerId=broker-remote",
          withBrokerAuth(),
        ),
      );
      const revoked = await revokedResponse.json();
      assertEquals(revoked.status, "revoked");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerServer federation stats and rotation endpoints validate and return lifecycle data",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const tunnelRegistry = new TunnelRegistry();
      const broker = new BrokerServer(createConfig(), {
        kv,
        tunnelRegistry,
        // deno-lint-ignore no-explicit-any
        metrics: { recordAgentMessage: async () => {} } as any,
      });
      const queuedMessages = createQueueCollector(kv);
      const handleHttp = (
        broker as unknown as {
          handleHttp(req: Request): Promise<Response>;
        }
      ).handleHttp.bind(broker);
      const adapter = await (
        broker as unknown as {
          getFederationAdapter(): Promise<{
            establishLink(input: {
              linkId?: string;
              localBrokerId: string;
              remoteBrokerId: string;
              requestedBy: string;
              correlation: {
                linkId: string;
                remoteBrokerId: string;
                traceId: string;
              };
            }): Promise<void>;
            recordCrossBrokerHop(event: {
              linkId: string;
              remoteBrokerId: string;
              taskId: string;
              contextId: string;
              traceId: string;
              latencyMs: number;
              success: boolean;
              occurredAt: string;
            }): Promise<void>;
            recordFederationDenial(event: {
              linkId: string;
              remoteBrokerId: string;
              taskId: string;
              contextId: string;
              traceId: string;
              kind: "policy" | "auth" | "not_found";
              decision:
                | "DENY_LOCAL_POLICY"
                | "DENY_REMOTE_POLICY"
                | "DENY_REMOTE_NOT_FOUND"
                | "AUTH_FAILED";
              errorCode?: string;
              occurredAt: string;
            }): Promise<void>;
            moveToDeadLetter(entry: {
              deadLetterId: string;
              idempotencyKey: string;
              remoteBrokerId: string;
              taskId: string;
              contextId: string;
              linkId: string;
              traceId: string;
              task: {
                targetAgent: string;
                taskId: string;
                contextId: string;
                taskMessage: A2AMessage;
              };
              payloadHash: string;
              attempts: number;
              reason: string;
              movedAt: string;
            }): Promise<void>;
          }>;
        }
      ).getFederationAdapter();

      await adapter.establishLink({
        linkId: "broker-local:broker-remote",
        localBrokerId: "broker-local",
        remoteBrokerId: "broker-remote",
        requestedBy: "broker-local",
        correlation: {
          linkId: "broker-local:broker-remote",
          remoteBrokerId: "broker-remote",
          traceId: "trace-link-stats",
        },
      });
      await adapter.recordCrossBrokerHop({
        linkId: "broker-local:broker-remote",
        remoteBrokerId: "broker-remote",
        taskId: "task-stats",
        contextId: "ctx-stats",
        traceId: "trace-stats",
        latencyMs: 42,
        success: true,
        occurredAt: "2026-03-30T00:00:01.000Z",
      });
      await adapter.recordFederationDenial({
        linkId: "broker-local:broker-remote",
        remoteBrokerId: "broker-remote",
        taskId: "task-policy",
        contextId: "ctx-policy",
        traceId: "trace-policy",
        kind: "policy",
        decision: "DENY_REMOTE_POLICY",
        occurredAt: "2026-03-30T00:00:02.000Z",
      });
      await adapter.recordFederationDenial({
        linkId: "broker-local:broker-remote",
        remoteBrokerId: "broker-remote",
        taskId: "task-auth",
        contextId: "ctx-auth",
        traceId: "trace-auth",
        kind: "auth",
        decision: "AUTH_FAILED",
        errorCode: "token_expired",
        occurredAt: "2026-03-30T00:00:03.000Z",
      });
      await adapter.moveToDeadLetter({
        deadLetterId: "dead-1",
        idempotencyKey: "broker-remote:task-stats:hash",
        remoteBrokerId: "broker-remote",
        taskId: "task-stats",
        contextId: "ctx-stats",
        linkId: "broker-local:broker-remote",
        traceId: "trace-stats",
        task: {
          targetAgent: "agent-remote",
          taskId: "task-stats",
          contextId: "ctx-stats",
          taskMessage: createMessage("Replay this task"),
        },
        payloadHash: "hash",
        attempts: 1,
        reason: "timeout",
        movedAt: new Date().toISOString(),
      });

      const statsResponse = await handleHttp(
        new Request(
          "http://localhost/federation/stats?remoteBrokerId=broker-remote",
          withBrokerAuth(),
        ),
      );
      assertEquals(statsResponse.status, 200);
      const stats = await statsResponse.json();
      assertEquals(stats.successCount, 1);
      assertEquals(stats.deadLetterBacklog, 1);
      assertEquals(stats.denials.policy, 1);
      assertEquals(stats.denials.auth, 1);
      assertEquals(stats.links[0].denials.policy, 1);
      assertEquals(stats.links[0].denials.auth, 1);
      assertEquals(stats.links[0].lastTaskId, "task-auth");

      const deadLettersResponse = await handleHttp(
        new Request(
          "http://localhost/federation/dead-letters?remoteBrokerId=broker-remote",
          withBrokerAuth(),
        ),
      );
      assertEquals(deadLettersResponse.status, 200);
      const deadLetters = await deadLettersResponse.json();
      assertEquals(deadLetters.length, 1);
      assertEquals(deadLetters[0].deadLetterId, "dead-1");
      assertEquals(deadLetters[0].task.targetAgent, "agent-remote");
      assertEquals(deadLetters[0].attempts, 1);

      const invalidReplayResponse = await handleHttp(
        new Request("http://localhost/federation/dead-letter/replay", {
          ...withBrokerAuth({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              remoteBrokerId: "broker-remote",
              deadLetterId: "",
            }),
          }),
        }),
      );
      assertEquals(invalidReplayResponse.status, 400);

      const missingReplayResponse = await handleHttp(
        new Request("http://localhost/federation/dead-letter/replay", {
          ...withBrokerAuth({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              remoteBrokerId: "broker-remote",
              deadLetterId: "missing",
            }),
          }),
        }),
      );
      assertEquals(missingReplayResponse.status, 404);

      const remoteTunnelMessages: BrokerMessage[] = [];
      const localTunnelMessages: BrokerMessage[] = [];
      const fakeRemoteTunnel = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send(raw: string) {
          remoteTunnelMessages.push(JSON.parse(raw) as BrokerMessage);
        },
        close() {},
      } as unknown as WebSocket;
      const fakeLocalTunnel = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send(raw: string) {
          localTunnelMessages.push(JSON.parse(raw) as BrokerMessage);
        },
        close() {},
      } as unknown as WebSocket;
      tunnelRegistry.register("broker-remote", fakeRemoteTunnel, {
        tunnelId: "broker-remote",
        type: "instance",
        tools: [],
        agents: ["agent-remote"],
        allowedAgents: [],
      });
      tunnelRegistry.register("shadow-local", fakeLocalTunnel, {
        tunnelId: "shadow-local",
        type: "local",
        tools: [],
        allowedAgents: ["agent-remote"],
      });

      const replayResponse = await handleHttp(
        new Request("http://localhost/federation/dead-letter/replay", {
          ...withBrokerAuth({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              remoteBrokerId: "broker-remote",
              deadLetterId: "dead-1",
              maxAttempts: 1,
            }),
          }),
        }),
      );
      assertEquals(replayResponse.status, 200);
      const replayBody = await replayResponse.json();
      assertEquals(replayBody.ok, true);
      assertEquals(replayBody.result.status, "forwarded");
      assertEquals(localTunnelMessages.length, 0);
      assertEquals(
        queuedMessages.some((message) =>
          message.type === "task_submit" && message.to === "agent-remote"
        ),
        false,
      );
      assertEquals(remoteTunnelMessages.length, 1);
      const replayedTask = remoteTunnelMessages[0] as Extract<
        BrokerMessage,
        { type: "task_submit" }
      >;
      assertEquals(replayedTask.from, "broker-local");
      assertEquals(replayedTask.payload.taskId, "task-stats");
      assertEquals(replayedTask.payload.contextId, "ctx-stats");
      assertEquals(replayedTask.payload.targetAgent, "agent-remote");

      const deadLettersAfterReplayResponse = await handleHttp(
        new Request(
          "http://localhost/federation/dead-letters?remoteBrokerId=broker-remote",
          withBrokerAuth(),
        ),
      );
      assertEquals(deadLettersAfterReplayResponse.status, 200);
      const deadLettersAfterReplay = await deadLettersAfterReplayResponse
        .json();
      assertEquals(deadLettersAfterReplay, []);

      const statsAfterReplayResponse = await handleHttp(
        new Request(
          "http://localhost/federation/stats?remoteBrokerId=broker-remote",
          withBrokerAuth(),
        ),
      );
      assertEquals(statsAfterReplayResponse.status, 200);
      const statsAfterReplay = await statsAfterReplayResponse.json();
      assertEquals(statsAfterReplay.deadLetterBacklog, 0);

      const rotateIdentityResponse = await handleHttp(
        new Request("http://localhost/federation/identity/rotate", {
          ...withBrokerAuth({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              brokerId: "broker-remote",
              nextPublicKey: "pub-key-v2",
            }),
          }),
        }),
      );
      assertEquals(rotateIdentityResponse.status, 200);
      const rotateIdentityBody = await rotateIdentityResponse.json();
      assertEquals(rotateIdentityBody.identity.activeKeyId, "pub-key-v2");

      const invalidSessionResponse = await handleHttp(
        new Request("http://localhost/federation/session/rotate", {
          ...withBrokerAuth({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              linkId: "broker-local:broker-remote",
              ttlSeconds: 0,
            }),
          }),
        }),
      );
      assertEquals(invalidSessionResponse.status, 400);

      const rotateSessionResponse = await handleHttp(
        new Request("http://localhost/federation/session/rotate", {
          ...withBrokerAuth({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              linkId: "broker-local:broker-remote",
              ttlSeconds: 60,
            }),
          }),
        }),
      );
      assertEquals(rotateSessionResponse.status, 200);
      const rotateSessionBody = await rotateSessionResponse.json();
      assertEquals(rotateSessionBody.session.status, "active");

      await broker.stop();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);
