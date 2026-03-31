import type { Config } from "../../config/mod.ts";
import { getConfigOrDefault, saveConfig } from "../../config/mod.ts";
import { SessionManager } from "../../messaging/session.ts";
import type {
  ChannelAddress,
  ChannelRouteScopeConfig,
  ChannelRoutingConfig,
  ChannelsConfig,
  Session,
} from "../../messaging/types.ts";
import { CliError, cliFlags, output, requireInteractive } from "../output.ts";
import { ask, choose, print, success } from "../prompt.ts";
import {
  assertKnownChannelRouteTargets,
  findExactChannelRouteScope,
  removeExactChannelRouteScope,
  resolveKnownAgentIds,
  upsertExactChannelRouteScope,
} from "./channels.ts";

interface ChannelAccountOption {
  channelType: "telegram" | "discord";
  accountId: string;
}

export async function setupChannelRoute(): Promise<void> {
  requireInteractive("denoclaw channel route");
  const config = await getConfigOrDefault();
  const knownAgentIds = resolveKnownAgentIds(config);
  const accountOptions = resolveConfiguredChannelAccounts(config.channels);

  if (accountOptions.length === 0) {
    throw new CliError(
      "CHANNEL_ROUTE_ACCOUNT_REQUIRED",
      "Configure Telegram or Discord first with 'denoclaw setup channel'",
    );
  }
  if (knownAgentIds.length === 0) {
    throw new CliError(
      "CHANNEL_ROUTE_TARGET_REQUIRED",
      "Create at least one agent before configuring a channel routing scope",
    );
  }

  print("\n── Channel Routing Scope ──\n");
  print(`  Known agents: ${knownAgentIds.join(", ")}`);
  printConfiguredChannelScopes(config);

  const accountChoice = await choose(
    "Select the channel account to scope",
    accountOptions.map(formatChannelAccountOption),
  );
  const selectedAccount = parseChannelAccountChoice(
    accountChoice,
    accountOptions,
  );

  const roomId = normalizeOptionalScopeValue(
    await ask(
      "Room ID / chat ID (empty = all rooms/chats for this account)",
      "",
    ),
  );
  const threadId = normalizeOptionalScopeValue(
    await ask(
      "Thread ID / topic ID (empty = no thread/topic restriction)",
      "",
    ),
  );
  if (threadId && !roomId) {
    throw new CliError(
      "CHANNEL_ROUTE_SCOPE_INVALID",
      "Set a roomId/chatId before adding a threadId/topicId restriction",
    );
  }

  const scope = {
    channelType: selectedAccount.channelType,
    accountId: selectedAccount.accountId,
    ...(roomId ? { roomId } : {}),
    ...(threadId ? { threadId } : {}),
  };
  const existingScope = findExactChannelRouteScope(
    config.channels.routing?.scopes,
    scope,
  );
  const delivery = await promptScopeDelivery(existingScope);

  config.channels.routing = ensureChannelRoutingConfig(config.channels.routing);
  if (delivery === "none") {
    config.channels.routing.scopes = removeExactChannelRouteScope(
      config.channels.routing.scopes,
      scope,
    );
    await saveConfig(config);
    success(`Removed routing scope ${formatChannelScope(scope)}.`);
    return;
  }

  const defaultTargets = existingScope?.delivery === delivery
    ? existingScope.targetAgentIds.join(", ")
    : undefined;
  const targetInput = await ask(
    delivery === "direct" ? "Target agent" : "Target agents (comma-separated)",
    defaultTargets,
  );
  const targetAgentIds = normalizeTargetAgentIds(targetInput);
  if (targetAgentIds.length === 0) {
    throw new CliError(
      "CHANNEL_ROUTE_TARGET_REQUIRED",
      "Select at least one target agent for this routing scope",
    );
  }

  assertKnownChannelRouteTargets(
    targetAgentIds,
    knownAgentIds,
    selectedAccount.channelType,
  );
  if (delivery === "direct" && targetAgentIds.length !== 1) {
    throw new CliError(
      "CHANNEL_ROUTE_DIRECT_TARGET_COUNT",
      "Direct routing requires exactly one target agent",
    );
  }

  config.channels.routing.scopes = upsertExactChannelRouteScope(
    config.channels.routing.scopes,
    {
      scope,
      delivery,
      targetAgentIds,
    },
  );
  await saveConfig(config);
  success(
    `Saved routing scope ${formatChannelScope(scope)} -> ${
      targetAgentIds.join(", ")
    } (${delivery}).`,
  );
}

export async function listChannelRoutes(): Promise<void> {
  const config = await getConfigOrDefault();
  const renderedScopes = renderConfiguredChannelScopes(config);

  if (!cliFlags().json) {
    if (renderedScopes.length === 0) {
      print("\n── Channel Routing Scopes ──\n");
      print("  No routing scopes configured.");
    } else {
      print("\n── Channel Routing Scopes ──\n");
      for (const scope of renderedScopes) {
        print(
          `  ${scope.label} -> ${
            scope.targetAgentIds.join(", ")
          } (${scope.delivery})`,
        );
      }
    }
  }

  output({
    scopes: renderedScopes.map((scope) => ({
      scope: scope.scope,
      label: scope.label,
      delivery: scope.delivery,
      targetAgentIds: scope.targetAgentIds,
    })),
    count: renderedScopes.length,
  });
}

export async function deleteChannelRoute(): Promise<void> {
  requireInteractive("denoclaw channel route delete");
  const config = await getConfigOrDefault();
  const scopes = config.channels.routing?.scopes ?? [];

  if (scopes.length === 0) {
    throw new CliError(
      "CHANNEL_ROUTE_NOT_FOUND",
      "No channel routing scope is configured",
    );
  }

  const renderedScopes = renderConfiguredChannelScopes(config);
  const choice = await choose(
    "Select the routing scope to delete",
    renderedScopes.map((scope) =>
      `${scope.label} -> ${scope.targetAgentIds.join(", ")} (${scope.delivery})`
    ),
  );
  const renderedScope = renderedScopes.find((scope) =>
    `${scope.label} -> ${
      scope.targetAgentIds.join(", ")
    } (${scope.delivery})` ===
      choice
  );
  if (!renderedScope) {
    throw new CliError(
      "CHANNEL_ROUTE_NOT_FOUND",
      `Unknown routing scope selection: ${choice}`,
    );
  }

  config.channels.routing = ensureChannelRoutingConfig(config.channels.routing);
  config.channels.routing.scopes = removeExactChannelRouteScope(
    config.channels.routing.scopes,
    renderedScope.scope,
  );
  await saveConfig(config);
  success(`Removed routing scope ${renderedScope.label}.`);
}

export async function discoverChannelRoutes(): Promise<void> {
  const sessionManager = new SessionManager();
  try {
    const discoveries = discoverChannelRouteScopes(
      await sessionManager.listAll(),
    );

    if (!cliFlags().json) {
      if (discoveries.length === 0) {
        print("\n── Observed Channel Scopes ──\n");
        print("  No observed Telegram/Discord scopes yet.");
      } else {
        print("\n── Observed Channel Scopes ──\n");
        for (const discovery of discoveries) {
          print(
            `  ${discovery.label} · lastSeen=${discovery.lastSeenAt} · session=${discovery.sessionId}`,
          );
        }
      }
    }

    output({
      discoveries,
      count: discoveries.length,
    });
  } finally {
    sessionManager.close();
  }
}

export function resolveConfiguredChannelAccounts(
  channels: ChannelsConfig,
): ChannelAccountOption[] {
  const accounts: ChannelAccountOption[] = [];

  if (channels.telegram?.enabled) {
    for (const account of channels.telegram.accounts ?? []) {
      accounts.push({
        channelType: "telegram",
        accountId: account.accountId,
      });
    }
  }

  if (channels.discord?.enabled) {
    for (const account of channels.discord.accounts ?? []) {
      accounts.push({
        channelType: "discord",
        accountId: account.accountId,
      });
    }
  }

  return accounts.sort((left, right) =>
    `${left.channelType}:${left.accountId}`.localeCompare(
      `${right.channelType}:${right.accountId}`,
    )
  );
}

export function formatChannelScope(
  scope: ChannelRouteScopeConfig["scope"],
): string {
  const parts = [`${scope.channelType}:${scope.accountId ?? "default"}`];
  if (scope.roomId) parts.push(`room=${scope.roomId}`);
  if (scope.threadId) parts.push(`thread=${scope.threadId}`);
  return parts.join(" ");
}

export function discoverChannelRouteScopes(sessions: Session[]): Array<{
  scope: ChannelRouteScopeConfig["scope"];
  label: string;
  sessionId: string;
  lastSeenAt: string;
  channelType: string;
  guildId?: string;
}> {
  const discovered = new Map<string, {
    scope: ChannelRouteScopeConfig["scope"];
    label: string;
    sessionId: string;
    lastSeenAt: string;
    channelType: string;
    guildId?: string;
  }>();

  const sortedSessions = [...sessions].sort((left, right) =>
    right.lastActivity.localeCompare(left.lastActivity)
  );

  for (const session of sortedSessions) {
    const channel = getSessionChannelDiscovery(session);
    if (!channel) continue;

    const scope = {
      channelType: channel.address.channelType,
      ...(channel.address.accountId
        ? { accountId: channel.address.accountId }
        : {}),
      ...(channel.address.roomId ? { roomId: channel.address.roomId } : {}),
      ...(channel.address.threadId
        ? { threadId: channel.address.threadId }
        : {}),
    };
    const key = JSON.stringify(scope);
    if (discovered.has(key)) continue;

    discovered.set(key, {
      scope,
      label: formatChannelScope(scope),
      sessionId: session.id,
      lastSeenAt: session.lastActivity,
      channelType: channel.address.channelType,
      ...(channel.guildId ? { guildId: channel.guildId } : {}),
    });
  }

  return [...discovered.values()];
}

function printConfiguredChannelScopes(config: Config): void {
  const scopes = renderConfiguredChannelScopes(config);
  if (scopes.length === 0) {
    print("  No routing scopes configured yet.");
    return;
  }

  print("  Existing scopes:");
  for (const scope of scopes) {
    print(
      `    ${scope.label} -> ${
        scope.targetAgentIds.join(", ")
      } (${scope.delivery})`,
    );
  }
}

function renderConfiguredChannelScopes(config: Config): Array<{
  scope: ChannelRouteScopeConfig["scope"];
  label: string;
  delivery: ChannelRouteScopeConfig["delivery"];
  targetAgentIds: string[];
}> {
  return (config.channels.routing?.scopes ?? []).map((scope) => ({
    scope: scope.scope,
    label: formatChannelScope(scope.scope),
    delivery: scope.delivery,
    targetAgentIds: [...scope.targetAgentIds],
  }));
}

function formatChannelAccountOption(option: ChannelAccountOption): string {
  const label = option.channelType === "telegram" ? "Telegram" : "Discord";
  return `${label} — ${option.accountId}`;
}

function parseChannelAccountChoice(
  choice: string,
  accountOptions: ChannelAccountOption[],
): ChannelAccountOption {
  const selected = accountOptions.find((option) =>
    formatChannelAccountOption(option) === choice
  );
  if (!selected) {
    throw new CliError(
      "CHANNEL_ROUTE_ACCOUNT_INVALID",
      `Unknown channel account selection: ${choice}`,
    );
  }
  return selected;
}

async function promptScopeDelivery(
  existingScope?: ChannelRouteScopeConfig,
): Promise<"none" | "direct" | "broadcast"> {
  const options = [
    `none       — ${
      existingScope
        ? "remove this exact routing scope"
        : "leave this scope unset"
    }`,
    "direct     — one target agent owns this scope",
    "broadcast  — multiple target agents receive this scope",
  ];

  if (existingScope?.delivery === "direct") {
    options.unshift(options.splice(1, 1)[0]);
  } else if (existingScope?.delivery === "broadcast") {
    options.unshift(options.splice(2, 1)[0]);
  }

  const choice = await choose("Routing mode for this exact scope", options);
  return choice.split("—")[0].trim().split(/\s+/)[0] as
    | "none"
    | "direct"
    | "broadcast";
}

function ensureChannelRoutingConfig(
  config?: ChannelRoutingConfig,
): ChannelRoutingConfig {
  return {
    ...config,
    scopes: config?.scopes ? [...config.scopes] : [],
  };
}

function normalizeOptionalScopeValue(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTargetAgentIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

export { formatChannelAccountOption };

function getSessionChannelDiscovery(session: Session): {
  address: ChannelAddress;
  guildId?: string;
} | null {
  const channel = session.metadata?.channel;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    return null;
  }

  const record = channel as Record<string, unknown>;
  const address = record.address;
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    return null;
  }

  const channelAddress = address as ChannelAddress;
  if (
    channelAddress.channelType !== "telegram" &&
    channelAddress.channelType !== "discord"
  ) {
    return null;
  }

  return {
    address: channelAddress,
    ...(typeof record.guildId === "string" ? { guildId: record.guildId } : {}),
  };
}
