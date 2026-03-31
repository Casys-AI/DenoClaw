import type { Config } from "../../config/mod.ts";
import { getConfigOrDefault, saveConfig } from "../../config/mod.ts";
import { CliError, requireInteractive } from "../output.ts";
import type {
  ChannelRouteScopeConfig,
  ChannelRoutingConfig,
  DiscordAccountConfig,
  DiscordConfig,
  TelegramAccountConfig,
  TelegramConfig,
} from "../../messaging/types.ts";
import { ask, choose, error, print, success } from "../prompt.ts";

export async function setupChannel(): Promise<void> {
  requireInteractive("denoclaw setup channel");
  const config = await getConfigOrDefault();
  const knownAgentIds = resolveKnownAgentIds(config);

  const choice = await choose("Which channel should be configured?", [
    "telegram  — Bot Telegram",
    "discord   — Bot Discord",
    "webhook   — Generic HTTP webhook",
  ]);
  const channelName = choice.split("—")[0].trim().split(/\s+/)[0];

  switch (channelName) {
    case "telegram": {
      const accountId = normalizeChannelAccountId(
        await ask("Telegram accountId (stable internal id, e.g. support-bot)"),
      );
      if (!accountId) {
        error("Empty accountId, canceled.");
        return;
      }

      const tokenEnvVar = normalizeChannelTokenEnvVar(
        await ask(
          "Env var holding the bot token",
          buildChannelTokenEnvVar("telegram", accountId),
        ),
      );
      if (!tokenEnvVar) {
        error("Empty env var name, canceled.");
        return;
      }

      const allowFrom = await ask(
        "Allowed user IDs (comma-separated, empty = all)",
      );
      const telegramConfig = ensureTelegramConfig(config.channels.telegram);
      const telegramAccount: TelegramAccountConfig = {
        accountId,
        tokenEnvVar,
        allowFrom: parseAllowedUserIds(allowFrom),
      };

      const existingAccounts = telegramConfig.accounts ?? [];
      const withoutCurrent = existingAccounts.filter((account) =>
        account.accountId !== accountId
      );
      telegramConfig.accounts = [...withoutCurrent, telegramAccount];
      telegramConfig.enabled = true;
      config.channels.telegram = telegramConfig;
      await applyTelegramOnboardingRouting(config, accountId, knownAgentIds);

      success(`Telegram configured for account '${accountId}'.`);
      print(`  export ${tokenEnvVar}=<token-from-botfather>`);
      print("  denoclaw dev");
      break;
    }

    case "webhook": {
      const port = parseInt(await ask("Port", "8787"));
      const secret = await ask(
        "Secret (Authorization header, empty = no secret)",
      );
      config.channels.webhook = {
        enabled: true,
        port: port || 8787,
        secret: secret || undefined,
      };

      success(`Webhook configured on port ${port || 8787}.`);
      print("  denoclaw dev");
      break;
    }

    case "discord": {
      const accountId = normalizeChannelAccountId(
        await ask("Discord accountId (stable internal id, e.g. support-bot)"),
      );
      if (!accountId) {
        error("Empty accountId, canceled.");
        return;
      }

      const tokenEnvVar = normalizeChannelTokenEnvVar(
        await ask(
          "Env var holding the bot token",
          buildChannelTokenEnvVar("discord", accountId),
        ),
      );
      if (!tokenEnvVar) {
        error("Empty env var name, canceled.");
        return;
      }

      const allowFrom = await ask(
        "Allowed user IDs (comma-separated, empty = all)",
      );
      const discordConfig = ensureDiscordConfig(config.channels.discord);
      const discordAccount: DiscordAccountConfig = {
        accountId,
        tokenEnvVar,
        allowFrom: parseAllowedUserIds(allowFrom),
      };

      const existingAccounts = discordConfig.accounts ?? [];
      const withoutCurrent = existingAccounts.filter((account) =>
        account.accountId !== accountId
      );
      discordConfig.accounts = [...withoutCurrent, discordAccount];
      discordConfig.enabled = true;
      config.channels.discord = discordConfig;
      await applyDiscordOnboardingRouting(config, accountId, knownAgentIds);

      success(`Discord configured for account '${accountId}'.`);
      print(`  export ${tokenEnvVar}=<discord-bot-token>`);
      print("  denoclaw dev");
      break;
    }
  }

  await saveConfig(config);
}

function ensureTelegramConfig(config?: TelegramConfig): TelegramConfig {
  if (!config) return { enabled: true, accounts: [] };
  return {
    ...config,
    enabled: true,
    accounts: config.accounts ? [...config.accounts] : [],
  };
}

function ensureDiscordConfig(config?: DiscordConfig): DiscordConfig {
  if (!config) return { enabled: true, accounts: [] };
  return {
    ...config,
    enabled: true,
    accounts: config.accounts ? [...config.accounts] : [],
  };
}

function parseAllowedUserIds(value: string): string[] | undefined {
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function normalizeChannelAccountId(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeChannelTokenEnvVar(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildChannelTokenEnvVar(
  channelType: "telegram" | "discord",
  accountId: string,
): string {
  const suffix = accountId
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `DENOCLAW_${channelType.toUpperCase()}_${suffix || "BOT"}_TOKEN`;
}

async function applyTelegramOnboardingRouting(
  config: Config,
  accountId: string,
  knownAgentIds: string[],
): Promise<void> {
  const scope = {
    channelType: "telegram",
    accountId,
  };
  const existingScope = findExactChannelRouteScope(
    config.channels.routing?.scopes,
    scope,
  );

  if (knownAgentIds.length === 0) {
    print(
      "  No agents configured yet. Telegram transport saved without a default routing scope.",
    );
    return;
  }

  print("\n── Telegram Routing ──\n");
  print(`  Known agents: ${knownAgentIds.join(", ")}`);
  const defaultAgentId = existingScope?.delivery === "direct"
    ? existingScope.targetAgentIds[0]
    : undefined;
  const routeInput = normalizeRouteAgentInput(
    await ask(
      "Default agent for this Telegram bot (empty = keep current, 'none' = no default route)",
      defaultAgentId,
    ),
  );

  if (routeInput === undefined) {
    if (!existingScope) {
      print("  No default Telegram routing scope configured.");
    }
    return;
  }

  if (routeInput === null) {
    config.channels.routing = ensureChannelRoutingConfig(
      config.channels.routing,
    );
    config.channels.routing.scopes = removeExactChannelRouteScope(
      config.channels.routing.scopes,
      scope,
    );
    print("  Removed the default Telegram routing scope for this bot.");
    return;
  }

  assertKnownChannelRouteTargets(routeInput, knownAgentIds, "telegram");
  if (routeInput.length !== 1) {
    throw new CliError(
      "CHANNEL_ROUTE_DIRECT_TARGET_COUNT",
      "Telegram direct routing requires exactly one target agent",
    );
  }
  config.channels.routing = ensureChannelRoutingConfig(config.channels.routing);
  config.channels.routing.scopes = upsertExactChannelRouteScope(
    config.channels.routing.scopes,
    {
      scope,
      delivery: "direct",
      targetAgentIds: [routeInput[0]],
    },
  );
  print(`  Default Telegram route: ${accountId} -> ${routeInput[0]}`);
}

async function applyDiscordOnboardingRouting(
  config: Config,
  accountId: string,
  knownAgentIds: string[],
): Promise<void> {
  const scope = {
    channelType: "discord",
    accountId,
  };
  const existingScope = findExactChannelRouteScope(
    config.channels.routing?.scopes,
    scope,
  );

  if (knownAgentIds.length === 0) {
    print(
      "  No agents configured yet. Discord transport saved without a default routing scope.",
    );
    return;
  }

  print("\n── Discord Routing ──\n");
  print(`  Known agents: ${knownAgentIds.join(", ")}`);
  print(
    "  This creates an account-level default scope. Room/thread-specific scopes can override it later.",
  );
  const delivery = await promptDiscordOnboardingDelivery(existingScope);

  if (delivery === "none") {
    config.channels.routing = ensureChannelRoutingConfig(
      config.channels.routing,
    );
    config.channels.routing.scopes = removeExactChannelRouteScope(
      config.channels.routing.scopes,
      scope,
    );
    print("  Removed the default Discord routing scope for this bot.");
    return;
  }

  const defaultTargets = existingScope?.delivery === delivery
    ? existingScope.targetAgentIds.join(", ")
    : undefined;
  const targetAgentIds = normalizeRouteAgentInput(
    await ask(
      delivery === "direct"
        ? "Default agent for this Discord bot"
        : "Default agents for this Discord bot (comma-separated)",
      defaultTargets,
    ),
  );

  if (!targetAgentIds || targetAgentIds.length === 0) {
    throw new CliError(
      "CHANNEL_ROUTE_TARGET_REQUIRED",
      `Select at least one agent for the default Discord ${delivery} scope`,
    );
  }

  assertKnownChannelRouteTargets(targetAgentIds, knownAgentIds, "discord");
  if (delivery === "direct" && targetAgentIds.length !== 1) {
    throw new CliError(
      "CHANNEL_ROUTE_DIRECT_TARGET_COUNT",
      "Direct Discord routing requires exactly one target agent",
    );
  }

  config.channels.routing = ensureChannelRoutingConfig(config.channels.routing);
  config.channels.routing.scopes = upsertExactChannelRouteScope(
    config.channels.routing.scopes,
    {
      scope,
      delivery,
      targetAgentIds,
    },
  );
  print(
    `  Default Discord route: ${accountId} -> ${
      targetAgentIds.join(", ")
    } (${delivery})`,
  );
}

async function promptDiscordOnboardingDelivery(
  existingScope?: ChannelRouteScopeConfig,
): Promise<"none" | "direct" | "broadcast"> {
  const options = [
    `none       — ${
      existingScope
        ? "remove the current default scope"
        : "transport only for now"
    }`,
    "direct     — route this bot to one agent by default",
    "broadcast  — fan out this bot to multiple agents by default",
  ];

  if (existingScope?.delivery === "direct") {
    options.unshift(options.splice(1, 1)[0]);
  } else if (existingScope?.delivery === "broadcast") {
    options.unshift(options.splice(2, 1)[0]);
  }

  const choice = await choose(
    "Default routing mode for this Discord bot",
    options,
  );
  return choice.split("—")[0].trim().split(/\s+/)[0] as
    | "none"
    | "direct"
    | "broadcast";
}

export function resolveKnownAgentIds(config: Pick<Config, "agents">): string[] {
  return Object.keys(config.agents.registry ?? {}).sort();
}

export function upsertExactChannelRouteScope(
  scopes: ChannelRouteScopeConfig[] | undefined,
  nextScope: ChannelRouteScopeConfig,
): ChannelRouteScopeConfig[] {
  const current = scopes ?? [];
  const updated = current.filter((scope) =>
    !isExactChannelRouteScopeMatch(scope, nextScope.scope)
  );
  updated.push(nextScope);
  return updated;
}

export function removeExactChannelRouteScope(
  scopes: ChannelRouteScopeConfig[] | undefined,
  targetScope: ChannelRouteScopeConfig["scope"],
): ChannelRouteScopeConfig[] {
  return (scopes ?? []).filter((scope) =>
    !isExactChannelRouteScopeMatch(scope, targetScope)
  );
}

export function findExactChannelRouteScope(
  scopes: ChannelRouteScopeConfig[] | undefined,
  targetScope: ChannelRouteScopeConfig["scope"],
): ChannelRouteScopeConfig | undefined {
  return (scopes ?? []).find((scope) =>
    isExactChannelRouteScopeMatch(scope, targetScope)
  );
}

export function assertKnownChannelRouteTargets(
  targetAgentIds: string[],
  knownAgentIds: string[],
  channelType: "telegram" | "discord",
): void {
  const unknownAgentIds = targetAgentIds.filter((agentId) =>
    !knownAgentIds.includes(agentId)
  );
  if (unknownAgentIds.length === 0) return;

  throw new CliError(
    "CHANNEL_ROUTE_UNKNOWN_AGENT",
    `Unknown ${channelType} route target(s): ${unknownAgentIds.join(", ")}`,
  );
}

function ensureChannelRoutingConfig(
  config?: ChannelRoutingConfig,
): ChannelRoutingConfig {
  return {
    ...config,
    scopes: config?.scopes ? [...config.scopes] : [],
  };
}

function isExactChannelRouteScopeMatch(
  existingScope: ChannelRouteScopeConfig,
  targetScope: ChannelRouteScopeConfig["scope"],
): boolean {
  return existingScope.scope.channelType === targetScope.channelType &&
    existingScope.scope.accountId === targetScope.accountId &&
    existingScope.scope.roomId === targetScope.roomId &&
    existingScope.scope.threadId === targetScope.threadId;
}

function normalizeRouteAgentInput(value: string): string[] | null | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.toLowerCase() === "none") return null;
  const targetAgentIds = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return targetAgentIds.length > 0 ? [...new Set(targetAgentIds)] : undefined;
}
