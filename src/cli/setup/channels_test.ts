import { assertEquals, assertThrows } from "@std/assert";
import { CliError } from "../output.ts";
import type { Config } from "../../config/mod.ts";
import {
  assertKnownChannelRouteTargets,
  findExactChannelRouteScope,
  removeExactChannelRouteScope,
  resolveKnownAgentIds,
  upsertExactChannelRouteScope,
} from "./channels.ts";

Deno.test("resolveKnownAgentIds returns sorted runtime agent ids", () => {
  const config: Pick<Config, "agents"> = {
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        temperature: 0.7,
        maxTokens: 4096,
      },
      registry: {
        bravo: { sandbox: { allowedPermissions: ["read"] } },
        alpha: { sandbox: { allowedPermissions: ["read"] } },
      },
    },
  };

  assertEquals(resolveKnownAgentIds(config), ["alpha", "bravo"]);
});

Deno.test("upsertExactChannelRouteScope replaces the matching scope only", () => {
  const scopes = upsertExactChannelRouteScope(
    [
      {
        scope: { channelType: "telegram", accountId: "support-bot" },
        delivery: "direct",
        targetAgentIds: ["agent-old"],
      },
      {
        scope: {
          channelType: "discord",
          accountId: "ops-bot",
          roomId: "room-1",
        },
        delivery: "broadcast",
        targetAgentIds: ["agent-a", "agent-b"],
      },
    ],
    {
      scope: { channelType: "telegram", accountId: "support-bot" },
      delivery: "direct",
      targetAgentIds: ["agent-new"],
    },
  );

  assertEquals(scopes, [
    {
      scope: {
        channelType: "discord",
        accountId: "ops-bot",
        roomId: "room-1",
      },
      delivery: "broadcast",
      targetAgentIds: ["agent-a", "agent-b"],
    },
    {
      scope: { channelType: "telegram", accountId: "support-bot" },
      delivery: "direct",
      targetAgentIds: ["agent-new"],
    },
  ]);
});

Deno.test("removeExactChannelRouteScope removes only the exact scope", () => {
  const scopes = removeExactChannelRouteScope(
    [
      {
        scope: { channelType: "telegram", accountId: "support-bot" },
        delivery: "direct",
        targetAgentIds: ["agent-telegram"],
      },
      {
        scope: {
          channelType: "discord",
          accountId: "ops-bot",
          roomId: "room-1",
        },
        delivery: "broadcast",
        targetAgentIds: ["agent-a", "agent-b"],
      },
    ],
    { channelType: "telegram", accountId: "support-bot" },
  );

  assertEquals(scopes, [
    {
      scope: {
        channelType: "discord",
        accountId: "ops-bot",
        roomId: "room-1",
      },
      delivery: "broadcast",
      targetAgentIds: ["agent-a", "agent-b"],
    },
  ]);
});

Deno.test("findExactChannelRouteScope returns only an exact scope match", () => {
  const scope = findExactChannelRouteScope(
    [
      {
        scope: {
          channelType: "discord",
          accountId: "ops-bot",
        },
        delivery: "broadcast",
        targetAgentIds: ["agent-a", "agent-b"],
      },
      {
        scope: {
          channelType: "discord",
          accountId: "ops-bot",
          roomId: "room-1",
        },
        delivery: "direct",
        targetAgentIds: ["agent-room"],
      },
    ],
    {
      channelType: "discord",
      accountId: "ops-bot",
      roomId: "room-1",
    },
  );

  assertEquals(scope, {
    scope: {
      channelType: "discord",
      accountId: "ops-bot",
      roomId: "room-1",
    },
    delivery: "direct",
    targetAgentIds: ["agent-room"],
  });
});

Deno.test("assertKnownChannelRouteTargets rejects unknown target agents", () => {
  assertThrows(
    () =>
      assertKnownChannelRouteTargets(
        ["agent-alpha", "agent-missing"],
        ["agent-alpha", "agent-beta"],
        "discord",
      ),
    CliError,
    "Unknown discord route target(s): agent-missing",
  );
});
