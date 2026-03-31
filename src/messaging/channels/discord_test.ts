import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError } from "../../shared/errors.ts";
import type { ChannelMessage } from "../types.ts";
import { DiscordChannel, resolveDiscordChannelConfigs } from "./discord.ts";

Deno.test(
  "resolveDiscordChannelConfigs builds one adapter config per discord account",
  () => {
    assertEquals(
      resolveDiscordChannelConfigs({
        enabled: true,
        accounts: [
          {
            accountId: "ops-bot",
            tokenEnvVar: "DISCORD_OPS_TOKEN",
          },
          {
            accountId: "support-bot",
            tokenEnvVar: "DISCORD_SUPPORT_TOKEN",
          },
        ],
      }),
      [
        {
          enabled: true,
          adapterId: "discord:ops-bot",
          accountId: "ops-bot",
          tokenEnvVar: "DISCORD_OPS_TOKEN",
        },
        {
          enabled: true,
          adapterId: "discord:support-bot",
          accountId: "support-bot",
          tokenEnvVar: "DISCORD_SUPPORT_TOKEN",
        },
      ],
    );
  },
);

Deno.test(
  "resolveDiscordChannelConfigs rejects duplicate accountIds in accounts[]",
  () => {
    assertThrows(
      () =>
        resolveDiscordChannelConfigs({
          enabled: true,
          accounts: [
            {
              accountId: "support-bot",
              tokenEnvVar: "DISCORD_ONE_TOKEN",
            },
            {
              accountId: "support-bot",
              tokenEnvVar: "DISCORD_TWO_TOKEN",
            },
          ],
        }),
      ConfigError,
      "Use a unique Discord accountId for each configured bot",
    );
  },
);

Deno.test(
  "DiscordChannel scopes session ids by bot accountId and channel id",
  async () => {
    const channel = new DiscordChannel({
      enabled: true,
      adapterId: "discord:support-bot",
      accountId: "support-bot",
      tokenEnvVar: "DISCORD_SUPPORT_TOKEN",
    });

    let received: ChannelMessage | undefined;
    const internal = channel as unknown as {
      botUserId?: string;
      routingAccountId?: string;
      onMessage?: (message: ChannelMessage) => void;
      handleMessageCreate(message: unknown): Promise<void>;
    };
    internal.botUserId = "999";
    internal.routingAccountId = "support-bot";
    internal.onMessage = (message) => {
      received = message;
    };

    await internal.handleMessageCreate({
      id: "42",
      content: "hello discord",
      channelId: "channel-7",
      guildId: "guild-1",
      timestamp: "2026-03-31T00:00:00.000Z",
      author: {
        id: "123",
        username: "alice",
        bot: false,
      },
    });

    assertEquals(received?.sessionId, "discord:support-bot:channel-7");
    assertEquals(received?.address.accountId, "support-bot");
    assertEquals(received?.address.roomId, "channel-7");
    assertEquals(received?.metadata?.guildId, "guild-1");
  },
);

Deno.test(
  "DiscordChannel distinguishes parent roomId and threadId for thread messages",
  async () => {
    const channel = new DiscordChannel({
      enabled: true,
      adapterId: "discord:support-bot",
      accountId: "support-bot",
      tokenEnvVar: "DISCORD_SUPPORT_TOKEN",
    });

    let received: ChannelMessage | undefined;
    const internal = channel as unknown as {
      botUserId?: string;
      routingAccountId?: string;
      bot?: {
        helpers: {
          getChannel(channelId: string): Promise<{
            id: bigint;
            parentId: bigint;
            type: number;
          }>;
        };
      };
      onMessage?: (message: ChannelMessage) => void;
      handleMessageCreate(message: unknown): Promise<void>;
    };
    internal.botUserId = "999";
    internal.routingAccountId = "support-bot";
    internal.bot = {
      helpers: {
        getChannel: async () => ({
          id: 300n,
          parentId: 200n,
          type: 11,
        }),
      },
    };
    internal.onMessage = (message) => {
      received = message;
    };

    await internal.handleMessageCreate({
      id: "42",
      content: "hello thread",
      channelId: "300",
      guildId: "guild-1",
      timestamp: "2026-03-31T00:00:00.000Z",
      author: {
        id: "123",
        username: "alice",
        bot: false,
      },
    });

    assertEquals(received?.sessionId, "discord:support-bot:300");
    assertEquals(received?.address.roomId, "200");
    assertEquals(received?.address.threadId, "300");
  },
);

Deno.test(
  "DiscordChannel retries thread scope resolution after a transient lookup failure",
  async () => {
    const channel = new DiscordChannel({
      enabled: true,
      adapterId: "discord:support-bot",
      accountId: "support-bot",
      tokenEnvVar: "DISCORD_SUPPORT_TOKEN",
    });

    const received: ChannelMessage[] = [];
    let getChannelCalls = 0;
    const internal = channel as unknown as {
      botUserId?: string;
      routingAccountId?: string;
      bot?: {
        helpers: {
          getChannel(channelId: string): Promise<{
            id: bigint;
            parentId: bigint;
            type: number;
          }>;
        };
      };
      onMessage?: (message: ChannelMessage) => void;
      handleMessageCreate(message: unknown): Promise<void>;
    };
    internal.botUserId = "999";
    internal.routingAccountId = "support-bot";
    internal.bot = {
      helpers: {
        getChannel: async () => {
          getChannelCalls += 1;
          if (getChannelCalls === 1) {
            throw new Error("temporary discord lookup failure");
          }
          return {
            id: 300n,
            parentId: 200n,
            type: 11,
          };
        },
      },
    };
    internal.onMessage = (message) => {
      received.push(message);
    };

    await internal.handleMessageCreate({
      id: "42",
      content: "first try",
      channelId: "300",
      guildId: "guild-1",
      timestamp: "2026-03-31T00:00:00.000Z",
      author: {
        id: "123",
        username: "alice",
        bot: false,
      },
    });
    await internal.handleMessageCreate({
      id: "43",
      content: "second try",
      channelId: "300",
      guildId: "guild-1",
      timestamp: "2026-03-31T00:00:01.000Z",
      author: {
        id: "123",
        username: "alice",
        bot: false,
      },
    });

    assertEquals(getChannelCalls, 2);
    assertEquals(received[0]?.address.roomId, "300");
    assertEquals(received[0]?.address.threadId, undefined);
    assertEquals(received[1]?.address.roomId, "200");
    assertEquals(received[1]?.address.threadId, "300");
  },
);

Deno.test("DiscordChannel ignores bot-authored messages", async () => {
  const channel = new DiscordChannel({
    enabled: true,
    adapterId: "discord:support-bot",
    accountId: "support-bot",
    tokenEnvVar: "DISCORD_SUPPORT_TOKEN",
  });

  let received = false;
  const internal = channel as unknown as {
    routingAccountId?: string;
    onMessage?: () => void;
    handleMessageCreate(message: unknown): Promise<void>;
  };
  internal.routingAccountId = "support-bot";
  internal.onMessage = () => {
    received = true;
  };

  await internal.handleMessageCreate({
    id: "42",
    content: "bot message",
    channelId: "channel-7",
    author: {
      id: "123",
      username: "another-bot",
      bot: true,
    },
  });

  assertEquals(received, false);
});
