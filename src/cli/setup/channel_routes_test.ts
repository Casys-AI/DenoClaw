import { assertEquals } from "@std/assert";
import { createDefaultConfig, saveConfig } from "../../config/mod.ts";
import type { ChannelsConfig } from "../../messaging/types.ts";
import { initCliFlags } from "../output.ts";
import {
  discoverChannelRouteScopes,
  formatChannelAccountOption,
  formatChannelScope,
  listChannelRoutes,
  resolveConfiguredChannelAccounts,
} from "./channel_routes.ts";

function captureConsoleLogAsync(fn: () => Promise<void>): {
  lines: string[];
  done: Promise<void>;
} {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const done = fn().finally(() => {
    console.log = original;
  });
  return { lines, done };
}

Deno.test("resolveConfiguredChannelAccounts returns enabled telegram and discord accounts", () => {
  const channels: ChannelsConfig = {
    telegram: {
      enabled: true,
      accounts: [
        { accountId: "support-bot", tokenEnvVar: "TG_SUPPORT" },
      ],
    },
    discord: {
      enabled: true,
      accounts: [
        { accountId: "ops-bot", tokenEnvVar: "DISCORD_OPS" },
      ],
    },
  };

  assertEquals(resolveConfiguredChannelAccounts(channels), [
    { channelType: "discord", accountId: "ops-bot" },
    { channelType: "telegram", accountId: "support-bot" },
  ]);
});

Deno.test("formatChannelScope renders account, room, and thread clearly", () => {
  assertEquals(
    formatChannelScope({
      channelType: "discord",
      accountId: "ops-bot",
      roomId: "room-1",
      threadId: "thread-2",
    }),
    "discord:ops-bot room=room-1 thread=thread-2",
  );
});

Deno.test("formatChannelAccountOption renders a readable prompt label", () => {
  assertEquals(
    formatChannelAccountOption({
      channelType: "telegram",
      accountId: "support-bot",
    }),
    "Telegram — support-bot",
  );
});

Deno.test("discoverChannelRouteScopes deduplicates sessions by exact channel scope", () => {
  const discoveries = discoverChannelRouteScopes([
    {
      id: "session-newest",
      userId: "user-1",
      channelType: "discord",
      createdAt: "2026-03-31T00:00:00.000Z",
      lastActivity: "2026-03-31T10:00:00.000Z",
      metadata: {
        channel: {
          address: {
            channelType: "discord",
            accountId: "ops-bot",
            roomId: "room-1",
            threadId: "thread-2",
          },
          guildId: "guild-1",
        },
      },
    },
    {
      id: "session-older-same-scope",
      userId: "user-2",
      channelType: "discord",
      createdAt: "2026-03-31T00:00:00.000Z",
      lastActivity: "2026-03-31T09:00:00.000Z",
      metadata: {
        channel: {
          address: {
            channelType: "discord",
            accountId: "ops-bot",
            roomId: "room-1",
            threadId: "thread-2",
          },
          guildId: "guild-1",
        },
      },
    },
    {
      id: "telegram-session",
      userId: "user-3",
      channelType: "telegram",
      createdAt: "2026-03-31T00:00:00.000Z",
      lastActivity: "2026-03-31T08:00:00.000Z",
      metadata: {
        channel: {
          address: {
            channelType: "telegram",
            accountId: "support-bot",
            roomId: "1234",
          },
        },
      },
    },
  ]);

  assertEquals(discoveries, [
    {
      scope: {
        channelType: "discord",
        accountId: "ops-bot",
        roomId: "room-1",
        threadId: "thread-2",
      },
      label: "discord:ops-bot room=room-1 thread=thread-2",
      sessionId: "session-newest",
      lastSeenAt: "2026-03-31T10:00:00.000Z",
      channelType: "discord",
      guildId: "guild-1",
    },
    {
      scope: {
        channelType: "telegram",
        accountId: "support-bot",
        roomId: "1234",
      },
      label: "telegram:support-bot room=1234",
      sessionId: "telegram-session",
      lastSeenAt: "2026-03-31T08:00:00.000Z",
      channelType: "telegram",
    },
  ]);
});

Deno.test({
  name: "listChannelRoutes emits structured JSON in JSON mode",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = createDefaultConfig();
      config.channels.routing = {
        scopes: [
          {
            scope: {
              channelType: "discord",
              accountId: "ops-bot",
              roomId: "room-1",
              threadId: "thread-2",
            },
            delivery: "broadcast",
            targetAgentIds: ["agent-alpha", "agent-beta"],
          },
        ],
      };
      await saveConfig(config);

      initCliFlags({ json: true }, { isTTY: true });
      const captured = captureConsoleLogAsync(() => listChannelRoutes());
      await captured.done;

      assertEquals(captured.lines.length, 1);
      assertEquals(JSON.parse(captured.lines[0]), {
        scopes: [
          {
            scope: {
              channelType: "discord",
              accountId: "ops-bot",
              roomId: "room-1",
              threadId: "thread-2",
            },
            label: "discord:ops-bot room=room-1 thread=thread-2",
            delivery: "broadcast",
            targetAgentIds: ["agent-alpha", "agent-beta"],
          },
        ],
        count: 1,
      });
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
