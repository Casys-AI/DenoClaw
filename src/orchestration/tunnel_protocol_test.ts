import { assertEquals, assertThrows } from "@std/assert";
import {
  assertTunnelRegisterMessage,
  createTunnelRegisterMessage,
  DENOCLAW_TUNNEL_PROTOCOL,
  getAcceptedTunnelProtocol,
  parseTunnelControlMessage,
  parseWebSocketProtocols,
} from "./tunnel_protocol.ts";

Deno.test("parseWebSocketProtocols trims and splits the request header", () => {
  assertEquals(parseWebSocketProtocols(null), []);
  assertEquals(parseWebSocketProtocols(""), []);
  assertEquals(
    parseWebSocketProtocols("chat, denoclaw.tunnel.v1 , json"),
    ["chat", "denoclaw.tunnel.v1", "json"],
  );
});

Deno.test("getAcceptedTunnelProtocol accepts only the denoclaw tunnel protocol", () => {
  assertEquals(getAcceptedTunnelProtocol(null), undefined);
  assertEquals(getAcceptedTunnelProtocol("chat, json"), undefined);
  assertEquals(
    getAcceptedTunnelProtocol(`chat, ${DENOCLAW_TUNNEL_PROTOCOL}`),
    DENOCLAW_TUNNEL_PROTOCOL,
  );
});

Deno.test("createTunnelRegisterMessage builds a strict canonical registration payload", () => {
  assertEquals(
    createTunnelRegisterMessage({
      tunnelType: "local",
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

Deno.test("assertTunnelRegisterMessage validates the registration shape", () => {
  assertEquals(
    assertTunnelRegisterMessage({
      type: "register",
      tunnelType: "instance",
      tools: [],
      agents: ["agent-alpha"],
      allowedAgents: [],
    }),
    {
      type: "register",
      tunnelType: "instance",
      tools: [],
      agents: ["agent-alpha"],
      allowedAgents: [],
    },
  );

  assertThrows(
    () =>
      assertTunnelRegisterMessage({
        type: "register",
        tunnelType: "local",
        tools: "shell",
        agents: [],
        allowedAgents: [],
      }),
    Error,
    "tools",
  );
});

Deno.test("parseTunnelControlMessage validates broker tunnel control frames", () => {
  assertEquals(
    parseTunnelControlMessage({
      type: "registered",
      tunnelId: "tunnel-1",
    }),
    {
      type: "registered",
      tunnelId: "tunnel-1",
    },
  );

  assertEquals(
    parseTunnelControlMessage({
      type: "session_token",
      token: "session-123",
      expiresAt: "2026-03-29T12:00:00.000Z",
    }),
    {
      type: "session_token",
      token: "session-123",
      expiresAt: "2026-03-29T12:00:00.000Z",
    },
  );

  assertEquals(
    parseTunnelControlMessage({ type: "tool_request", payload: {} }),
    null,
  );

  assertThrows(
    () => parseTunnelControlMessage({ type: "registered", tunnelId: "" }),
    Error,
    "tunnelId",
  );
});
