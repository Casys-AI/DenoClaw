import { assertEquals, assertRejects } from "@std/assert";
import { DenoClawError } from "../../shared/errors.ts";
import { resolveGatewayChannelRoute } from "./channel_routing.ts";

function createMessage(metadata?: Record<string, unknown>) {
  return {
    id: "msg-1",
    sessionId: "session-1",
    userId: "user-1",
    content: "hello",
    channelType: "telegram",
    timestamp: new Date().toISOString(),
    address: {
      channelType: "telegram",
      roomId: "room-1",
      userId: "user-1",
    },
    ...(metadata ? { metadata } : {}),
  };
}

Deno.test("resolveGatewayChannelRoute honors explicit metadata agentId", () => {
  assertEquals(
    resolveGatewayChannelRoute(createMessage({ agentId: "agent-beta" }), [
      "agent-alpha",
    ]),
    { agentId: "agent-beta" },
  );
});

Deno.test("resolveGatewayChannelRoute falls back to the single running agent", () => {
  assertEquals(
    resolveGatewayChannelRoute(createMessage(), ["agent-alpha"]),
    { agentId: "agent-alpha" },
  );
});

Deno.test("resolveGatewayChannelRoute rejects ambiguous multi-agent traffic", async () => {
  await assertRejects(
    async () =>
      await Promise.resolve(
        resolveGatewayChannelRoute(createMessage(), [
          "agent-alpha",
          "agent-beta",
        ]),
      ),
    DenoClawError,
    "Provide an explicit agentId for channel traffic when multiple agents are running",
  );
});
