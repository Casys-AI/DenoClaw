import { assertEquals, assertRejects } from "@std/assert";
import type {
  FederationControlEnvelope,
  FederationService,
} from "../federation/mod.ts";
import { createBrokerFederationControlHandlers } from "./federation_control_handlers.ts";
import { handleBrokerFederationControlMessage } from "./federation_runtime.ts";

function createEnvelope(
  type: FederationControlEnvelope["type"],
  payload: Record<string, unknown>,
): FederationControlEnvelope {
  return {
    id: "msg-1",
    from: "broker-remote",
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

Deno.test("createBrokerFederationControlHandlers opens links and replies with ack", async () => {
  const opened: unknown[] = [];
  const replies: unknown[] = [];
  const service = {
    openLink: (input: unknown) => {
      opened.push(input);
      return Promise.resolve();
    },
  } as unknown as FederationService;
  const handlers = createBrokerFederationControlHandlers({
    findRemoteBrokerConnection: () => null,
    routeToTunnel: () => {},
    getFederationService: () => Promise.resolve(service),
    sendReply: (reply) => {
      replies.push(reply);
      return Promise.resolve();
    },
  });

  await handlers.federation_link_open(
    createEnvelope("federation_link_open", {
      linkId: "link-1",
      localBrokerId: "broker-local",
      remoteBrokerId: "broker-remote",
      traceId: "trace-1",
    }),
  );

  assertEquals(opened, [{
    linkId: "link-1",
    localBrokerId: "broker-local",
    remoteBrokerId: "broker-remote",
    requestedBy: "broker-remote",
    traceId: "trace-1",
  }]);
  assertEquals(replies.length, 1);
  assertEquals((replies[0] as { type: string }).type, "federation_link_ack");
});

Deno.test("createBrokerFederationControlHandlers validates catalog payloads", async () => {
  const handlers = createBrokerFederationControlHandlers({
    findRemoteBrokerConnection: () => null,
    routeToTunnel: () => {},
    getFederationService: () => Promise.resolve({} as FederationService),
    sendReply: () => Promise.resolve(),
  });

  await assertRejects(
    () =>
      handlers.federation_catalog_sync(
        createEnvelope("federation_catalog_sync", {
          remoteBrokerId: "broker-remote",
          traceId: "trace-1",
          agents: "not-an-array",
        }),
      ),
    Error,
    "FEDERATION_PAYLOAD_INVALID",
  );
});

Deno.test("federation_catalog_sync propagates agent cards", async () => {
  const synced: unknown[] = [];
  const service = {
    syncCatalog: (
      _remoteBrokerId: string,
      entries: unknown[],
      _meta: unknown,
    ) => {
      synced.push(...entries);
      return Promise.resolve();
    },
  } as unknown as import("../federation/mod.ts").FederationService;
  const handlers = createBrokerFederationControlHandlers({
    findRemoteBrokerConnection: () => null,
    routeToTunnel: () => {},
    getFederationService: () => Promise.resolve(service),
    sendReply: () => Promise.resolve(),
  });

  const card: import("../../messaging/a2a/types.ts").AgentCard = {
    name: "alice",
    description: "test agent",
    version: "0.1.0",
    protocolVersion: "1.0",
    url: "http://localhost:3000",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
  };

  await handlers.federation_catalog_sync(
    createEnvelope("federation_catalog_sync", {
      remoteBrokerId: "broker-remote",
      traceId: "trace-1",
      agents: [
        { agentId: "alice", card },
        { agentId: "bob" },
        "charlie",
      ],
    }),
  );

  assertEquals(synced.length, 3);
  assertEquals((synced[0] as { agentId: string; card: unknown }).agentId, "alice");
  assertEquals((synced[0] as { card: unknown }).card, card);
  assertEquals((synced[1] as { agentId: string; card: unknown }).agentId, "bob");
  assertEquals((synced[1] as { card: unknown }).card, null);
  assertEquals((synced[2] as { agentId: string; card: unknown }).agentId, "charlie");
  assertEquals((synced[2] as { card: unknown }).card, null);
});

Deno.test("handleBrokerFederationControlMessage rejects non-control methods", async () => {
  await assertRejects(
    () =>
      handleBrokerFederationControlMessage(
        async () => {},
        {
          id: "msg-1",
          from: "broker-local",
          to: "broker-remote",
          type: "task_submit",
          payload: {
            targetAgent: "agent-beta",
            taskId: "task-1",
            taskMessage: {
              role: "user",
              messageId: "msg-1",
              parts: [{ kind: "text", text: "hello" }],
            },
          },
          timestamp: new Date().toISOString(),
        } as unknown as import("../types.ts").BrokerFederationMessage,
      ),
    Error,
    "Use federation control-plane method names",
  );
});
