import { assertEquals, assertRejects } from "@std/assert";
import { DenoClawError } from "../../shared/errors.ts";
import { resolveGatewayChannelRoutePlan } from "./channel_routing.ts";
import type { ChannelsConfig } from "../../messaging/types.ts";

function createMessage(
  metadata?: Record<string, unknown>,
  address?: Record<string, unknown>,
  channelType = "telegram",
) {
  return {
    id: "msg-1",
    sessionId: "session-1",
    userId: "user-1",
    content: "hello",
    channelType,
    timestamp: new Date().toISOString(),
    address: {
      channelType,
      roomId: "room-1",
      userId: "user-1",
      ...(address ?? {}),
    },
    ...(metadata ? { metadata } : {}),
  };
}

Deno.test("resolveGatewayChannelRoutePlan honors explicit metadata agentId", () => {
  assertEquals(
    resolveGatewayChannelRoutePlan(
      createMessage({ agentId: "agent-beta" }),
      ["agent-alpha", "agent-beta"],
    ),
    {
      delivery: "direct",
      targetAgentIds: ["agent-beta"],
      primaryAgentId: "agent-beta",
    },
  );
});

Deno.test(
  "resolveGatewayChannelRoutePlan resolves telegram direct policy from configured channel scopes",
  () => {
    const config: ChannelsConfig = {
      routing: {
        scopes: [
          {
            scope: {
              channelType: "telegram",
              accountId: "botfather-helper",
            },
            delivery: "direct",
            targetAgentIds: ["agent-telegram"],
          },
        ],
      },
    };

    assertEquals(
      resolveGatewayChannelRoutePlan(
        createMessage(
          undefined,
          { accountId: "botfather-helper", roomId: "123" },
          "telegram",
        ),
        ["agent-telegram"],
        config,
      ),
      {
        delivery: "direct",
        targetAgentIds: ["agent-telegram"],
        primaryAgentId: "agent-telegram",
      },
    );
  },
);

Deno.test(
  "resolveGatewayChannelRoutePlan resolves discord broadcast policy from configured shared scope",
  () => {
    const config: ChannelsConfig = {
      routing: {
        scopes: [
          {
            scope: {
              channelType: "discord",
              roomId: "room-1",
              threadId: "thread-1",
            },
            delivery: "broadcast",
            targetAgentIds: ["agent-alpha", "agent-beta"],
          },
        ],
      },
    };

    assertEquals(
      resolveGatewayChannelRoutePlan(
        createMessage(
          undefined,
          { roomId: "room-1", threadId: "thread-1" },
          "discord",
        ),
        ["agent-alpha", "agent-beta"],
        config,
      ),
      {
        delivery: "broadcast",
        targetAgentIds: ["agent-alpha", "agent-beta"],
      },
    );
  },
);

Deno.test(
  "resolveGatewayChannelRoutePlan falls back to the single running agent",
  () => {
    assertEquals(
      resolveGatewayChannelRoutePlan(createMessage(), ["agent-alpha"]),
      {
        delivery: "direct",
        targetAgentIds: ["agent-alpha"],
        primaryAgentId: "agent-alpha",
      },
    );
  },
);

Deno.test(
  "resolveGatewayChannelRoutePlan rejects ambiguous multi-agent traffic",
  async () => {
    await assertRejects(
      async () =>
        await Promise.resolve(
          resolveGatewayChannelRoutePlan(createMessage(), [
            "agent-alpha",
            "agent-beta",
          ]),
        ),
      DenoClawError,
      "Provide an explicit agentId for channel traffic when multiple agents are running",
    );
  },
);

Deno.test(
  "resolveGatewayChannelRoutePlan rejects configured targets that are not running",
  async () => {
    const config: ChannelsConfig = {
      routing: {
        scopes: [
          {
            scope: { channelType: "discord", roomId: "room-1" },
            delivery: "broadcast",
            targetAgentIds: ["agent-alpha", "agent-beta"],
          },
        ],
      },
    };

    await assertRejects(
      async () =>
        await Promise.resolve(
          resolveGatewayChannelRoutePlan(
            createMessage(undefined, { roomId: "room-1" }, "discord"),
            ["agent-alpha"],
            config,
          ),
        ),
      DenoClawError,
      "Start the configured target agents before accepting this channel scope",
    );
  },
);
