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
    "agents must be a string[]",
  );
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
