import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError } from "../../shared/errors.ts";
import type { ChannelMessage } from "../types.ts";
import { resolveTelegramChannelConfigs, TelegramChannel } from "./telegram.ts";

Deno.test(
  "resolveTelegramChannelConfigs builds one adapter config per telegram account",
  () => {
    assertEquals(
      resolveTelegramChannelConfigs({
        enabled: true,
        accounts: [
          {
            accountId: "sales-bot",
            tokenEnvVar: "TG_SALES_TOKEN",
          },
          {
            accountId: "support-bot",
            tokenEnvVar: "TG_SUPPORT_TOKEN",
          },
        ],
      }),
      [
        {
          enabled: true,
          adapterId: "telegram:sales-bot",
          accountId: "sales-bot",
          tokenEnvVar: "TG_SALES_TOKEN",
        },
        {
          enabled: true,
          adapterId: "telegram:support-bot",
          accountId: "support-bot",
          tokenEnvVar: "TG_SUPPORT_TOKEN",
        },
      ],
    );
  },
);

Deno.test(
  "resolveTelegramChannelConfigs rejects duplicate accountIds in accounts[]",
  () => {
    assertThrows(
      () =>
        resolveTelegramChannelConfigs({
          enabled: true,
          accounts: [
            {
              accountId: "support-bot",
              tokenEnvVar: "TG_ONE_TOKEN",
            },
            {
              accountId: "support-bot",
              tokenEnvVar: "TG_TWO_TOKEN",
            },
          ],
        }),
      ConfigError,
      "Use a unique Telegram accountId for each configured bot",
    );
  },
);

Deno.test(
  "resolveTelegramChannelConfigs rejects empty accountIds in accounts[]",
  () => {
    assertThrows(
      () =>
        resolveTelegramChannelConfigs({
          enabled: true,
          accounts: [
            {
              accountId: "   ",
              tokenEnvVar: "TG_SUPPORT_TOKEN",
            },
          ],
        }),
      ConfigError,
      "Set a non-empty Telegram accountId for each configured bot",
    );
  },
);

Deno.test(
  "TelegramChannel scopes session ids by bot accountId and chat id",
  async () => {
    const channel = new TelegramChannel({
      enabled: true,
      adapterId: "telegram:support-bot",
      accountId: "support-bot",
      tokenEnvVar: "TG_SUPPORT_TOKEN",
    });

    let received: ChannelMessage | undefined;
    const internal = channel as unknown as {
      routingAccountId?: string;
      onMessage?: (message: ChannelMessage) => void;
      handleUpdate(update: unknown): Promise<void>;
    };
    internal.routingAccountId = "support-bot";
    internal.onMessage = (message) => {
      received = message;
    };

    await internal.handleUpdate({
      update_id: 1,
      message: {
        message_id: 42,
        date: 1_710_000_000,
        text: "hello",
        chat: { id: 99 },
        from: {
          id: 7,
          username: "alice",
          first_name: "Alice",
        },
      },
    });

    assertEquals(received?.sessionId, "telegram:support-bot:99");
    assertEquals(received?.address.accountId, "support-bot");
  },
);

Deno.test(
  "TelegramChannel does not reuse the same session across different chats",
  async () => {
    const channel = new TelegramChannel({
      enabled: true,
      adapterId: "telegram:support-bot",
      accountId: "support-bot",
      tokenEnvVar: "TG_SUPPORT_TOKEN",
    });

    const received: ChannelMessage[] = [];
    const internal = channel as unknown as {
      routingAccountId?: string;
      onMessage?: (message: ChannelMessage) => void;
      handleUpdate(update: unknown): Promise<void>;
    };
    internal.routingAccountId = "support-bot";
    internal.onMessage = (message) => {
      received.push(message);
    };

    await internal.handleUpdate({
      update_id: 1,
      message: {
        message_id: 42,
        date: 1_710_000_000,
        text: "hello direct",
        chat: { id: 99 },
        from: {
          id: 7,
          username: "alice",
          first_name: "Alice",
        },
      },
    });
    await internal.handleUpdate({
      update_id: 2,
      message: {
        message_id: 43,
        date: 1_710_000_001,
        text: "hello group",
        chat: { id: 1234 },
        from: {
          id: 7,
          username: "alice",
          first_name: "Alice",
        },
      },
    });

    assertEquals(received.map((message) => message.sessionId), [
      "telegram:support-bot:99",
      "telegram:support-bot:1234",
    ]);
  },
);

Deno.test(
  "TelegramChannel scopes forum topic messages by thread id when present",
  async () => {
    const channel = new TelegramChannel({
      enabled: true,
      adapterId: "telegram:support-bot",
      accountId: "support-bot",
      tokenEnvVar: "TG_SUPPORT_TOKEN",
    });

    let received: ChannelMessage | undefined;
    const internal = channel as unknown as {
      routingAccountId?: string;
      onMessage?: (message: ChannelMessage) => void;
      handleUpdate(update: unknown): Promise<void>;
    };
    internal.routingAccountId = "support-bot";
    internal.onMessage = (message) => {
      received = message;
    };

    await internal.handleUpdate({
      update_id: 1,
      message: {
        message_id: 42,
        date: 1_710_000_000,
        message_thread_id: 77,
        text: "hello topic",
        chat: { id: -10001 },
        from: {
          id: 7,
          username: "alice",
          first_name: "Alice",
        },
      },
    });

    assertEquals(received?.sessionId, "telegram:support-bot:77");
    assertEquals(received?.address.roomId, "-10001");
    assertEquals(received?.address.threadId, "77");
    assertEquals(received?.metadata?.messageThreadId, "77");
  },
);
