import { assertEquals, assertRejects } from "@std/assert";
import type {
  FederatedRoutePolicy,
  FederationCorrelationContext,
} from "../federation/mod.ts";
import { createBrokerFederationRoutingPort } from "./federation_routing_port.ts";
import type { TunnelConnection } from "./tunnel_registry.ts";

function createCorrelation(): FederationCorrelationContext {
  return {
    linkId: "broker-alpha:remote-broker",
    remoteBrokerId: "remote-broker",
    traceId: "trace-1",
    taskId: "task-1",
    contextId: "ctx-1",
  };
}

function createPolicy(): FederatedRoutePolicy {
  return {
    policyId: "policy-1",
    preferLocal: false,
    preferredRemoteBrokerIds: [],
    denyAgentIds: [],
  };
}

Deno.test("createBrokerFederationRoutingPort resolves unavailable remotes", async () => {
  const port = createBrokerFederationRoutingPort({
    findRemoteBrokerConnection: () => null,
    routeToTunnel: () => {},
    getFederationService: () => Promise.reject(new Error("unused")),
    sendReply: () => Promise.resolve(),
  });

  const result = await port.resolveTarget(
    {
      targetAgent: "agent-beta",
      taskId: "task-1",
      taskMessage: {
        role: "user",
        messageId: "msg-1",
        parts: [{ kind: "text", text: "hello" }],
      },
    },
    createPolicy(),
    createCorrelation(),
  );

  assertEquals(result, {
    kind: "remote",
    remoteBrokerId: "remote-broker",
    reason: "remote_broker_unavailable",
  });
});

Deno.test("createBrokerFederationRoutingPort forwards canonical task messages", async () => {
  const routed: unknown[] = [];
  const tunnel = {
    ws: {} as WebSocket,
    capabilities: {
      tunnelId: "remote-broker",
      type: "instance",
      tools: [],
      allowedAgents: [],
      agents: ["agent-beta"],
    },
    registered: true,
  } as TunnelConnection;
  const port = createBrokerFederationRoutingPort({
    findRemoteBrokerConnection: () => tunnel,
    routeToTunnel: (_ws, msg) => routed.push(msg),
    getFederationService: () => Promise.reject(new Error("unused")),
    sendReply: () => Promise.resolve(),
  });

  await port.forwardTask(
    {
      targetAgent: "agent-beta",
      taskId: "ignored-task",
      contextId: "ignored-context",
      taskMessage: {
        role: "user",
        messageId: "msg-1",
        parts: [{ kind: "text", text: "hello" }],
      },
    },
    "remote-broker",
    createCorrelation(),
  );

  assertEquals(routed.length, 1);
  const message = routed[0] as {
    from: string;
    to: string;
    type: string;
    payload: { taskId: string; contextId: string };
  };
  assertEquals(message.from, "broker-alpha");
  assertEquals(message.to, "agent-beta");
  assertEquals(message.type, "task_submit");
  assertEquals(message.payload.taskId, "task-1");
  assertEquals(message.payload.contextId, "ctx-1");
});

Deno.test("createBrokerFederationRoutingPort rejects non-advertised agents", async () => {
  const tunnel = {
    ws: {} as WebSocket,
    capabilities: {
      tunnelId: "remote-broker",
      type: "instance",
      tools: [],
      allowedAgents: [],
      agents: ["agent-gamma"],
    },
    registered: true,
  } as TunnelConnection;
  const port = createBrokerFederationRoutingPort({
    findRemoteBrokerConnection: () => tunnel,
    routeToTunnel: () => {},
    getFederationService: () => Promise.reject(new Error("unused")),
    sendReply: () => Promise.resolve(),
  });

  await assertRejects(
    () =>
      port.forwardTask(
        {
          targetAgent: "agent-beta",
          taskId: "task-1",
          taskMessage: {
            role: "user",
            messageId: "msg-1",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
        "remote-broker",
        createCorrelation(),
      ),
    Error,
    "target_not_advertised",
  );
});
