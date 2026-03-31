import { assertEquals, assertThrows } from "@std/assert";
import type { ChannelMessage, ChannelsConfig } from "../../messaging/types.ts";
import { resolveConfiguredChannelRoutePlan } from "./policy.ts";

function createMessage(
  overrides: Partial<ChannelMessage> & {
    address?: Partial<ChannelMessage["address"]>;
  } = {},
): ChannelMessage {
  const channelType = overrides.channelType ?? "discord";
  return {
    id: overrides.id ?? "msg-1",
    sessionId: overrides.sessionId ?? "session-1",
    userId: overrides.userId ?? "user-1",
    content: overrides.content ?? "hello",
    channelType,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    address: {
      channelType,
      accountId: "workspace-bot",
      roomId: "room-1",
      threadId: "thread-1",
      ...(overrides.address ?? {}),
    },
    metadata: overrides.metadata,
  };
}

Deno.test("resolveConfiguredChannelRoutePlan returns null when no scope matches", () => {
  const plan = resolveConfiguredChannelRoutePlan(createMessage(), {
    routing: {
      scopes: [
        {
          scope: { channelType: "telegram" },
          delivery: "direct",
          targetAgentIds: ["agent-telegram"],
        },
      ],
    },
  });

  assertEquals(plan, null);
});

Deno.test("resolveConfiguredChannelRoutePlan builds a direct telegram route from scoped config", () => {
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
          metadata: { source: "telegram-scope" },
        },
      ],
    },
  };

  const plan = resolveConfiguredChannelRoutePlan(
    createMessage({
      channelType: "telegram",
      address: {
        channelType: "telegram",
        accountId: "botfather-helper",
        roomId: "123",
      },
    }),
    config,
  );

  assertEquals(plan, {
    delivery: "direct",
    targetAgentIds: ["agent-telegram"],
    primaryAgentId: "agent-telegram",
    metadata: { source: "telegram-scope" },
  });
});

Deno.test("resolveConfiguredChannelRoutePlan prefers the most specific discord scope", () => {
  const config: ChannelsConfig = {
    routing: {
      scopes: [
        {
          scope: { channelType: "discord", roomId: "room-1" },
          delivery: "broadcast",
          targetAgentIds: ["agent-room"],
        },
        {
          scope: {
            channelType: "discord",
            roomId: "room-1",
            threadId: "thread-1",
          },
          delivery: "broadcast",
          targetAgentIds: ["agent-thread-a", "agent-thread-b"],
        },
      ],
    },
  };

  const plan = resolveConfiguredChannelRoutePlan(createMessage(), config);

  assertEquals(plan, {
    delivery: "broadcast",
    targetAgentIds: ["agent-thread-a", "agent-thread-b"],
  });
});

Deno.test("resolveConfiguredChannelRoutePlan rejects ambiguous equally-specific scopes", () => {
  const config: ChannelsConfig = {
    routing: {
      scopes: [
        {
          scope: { channelType: "discord", roomId: "room-1" },
          delivery: "broadcast",
          targetAgentIds: ["agent-a"],
        },
        {
          scope: { channelType: "discord", roomId: "room-1" },
          delivery: "broadcast",
          targetAgentIds: ["agent-b"],
        },
      ],
    },
  };

  assertThrows(
    () => resolveConfiguredChannelRoutePlan(createMessage(), config),
    Error,
    "Make channel routing scopes more specific",
  );
});
