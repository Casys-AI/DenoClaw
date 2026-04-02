import { assertEquals, assertThrows } from "@std/assert";
import {
  assertRelaySocketWritable,
  buildRelayRegistrationMessage,
  buildRelaySocketOptions,
  describeRelayExecutionMode,
  resolveRelayAuthToken,
} from "./relay.ts";
import { DENOCLAW_TUNNEL_PROTOCOL } from "./tunnel_protocol.ts";

Deno.test("buildRelaySocketOptions uses Authorization header and strict subprotocol", () => {
  const options = buildRelaySocketOptions("invite-123");
  assertEquals(options.headers.authorization, "Bearer invite-123");
  assertEquals(options.protocols, [DENOCLAW_TUNNEL_PROTOCOL]);
});

Deno.test("resolveRelayAuthToken prefers the session token once issued", () => {
  assertEquals(resolveRelayAuthToken("invite-123", null), "invite-123");
  assertEquals(
    resolveRelayAuthToken("invite-123", "session-456"),
    "session-456",
  );
});

Deno.test("describeRelayExecutionMode makes broker-owned approval explicit", () => {
  assertEquals(
    describeRelayExecutionMode(true),
    "Relay: local execution (auto-approve)",
  );
  assertEquals(
    describeRelayExecutionMode(false),
    "Relay: approval is broker-controlled; executing broker-approved request",
  );
});

Deno.test("buildRelayRegistrationMessage emits the strict tunnel register payload", () => {
  assertEquals(
    buildRelayRegistrationMessage({
      tools: ["shell"],
      allowedAgents: ["agent-alpha"],
    }),
    {
      type: "register",
      tunnelType: "local",
      tools: ["shell"],
      agents: [],
      allowedAgents: ["agent-alpha"],
    },
  );
});

Deno.test("assertRelaySocketWritable rejects closed or saturated sockets", () => {
  assertThrows(
    () =>
      assertRelaySocketWritable({
        readyState: WebSocket.CLOSED,
        bufferedAmount: 0,
      }),
    Error,
    "RELAY_SOCKET_NOT_WRITABLE",
  );
  assertThrows(
    () =>
      assertRelaySocketWritable({
        readyState: WebSocket.OPEN,
        bufferedAmount: 2_000_000,
      }),
    Error,
    "RELAY_SOCKET_SATURATED",
  );
  assertRelaySocketWritable({ readyState: WebSocket.OPEN, bufferedAmount: 0 });
});
