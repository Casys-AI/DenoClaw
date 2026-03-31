import type { Config } from "./types.ts";
import type { AgentEntry } from "../shared/types.ts";
import {
  ConfigError,
  ensureDir,
  fileExists,
  getConfigPath,
  getHomeDir,
  log,
} from "../shared/mod.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";

export interface SaveConfigOptions {
  persistAgentRegistry?: boolean;
}

function createDefaultConfig(): Config {
  return {
    providers: {},
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        temperature: 0.7,
        maxTokens: 4096,
      },
    },
    tools: { restrictToWorkspace: false },
    channels: {},
  };
}

function mergeEnvConfig(config: Config): Config {
  const envKeys: Record<string, string> = {
    OPENROUTER_API_KEY: "openrouter",
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    DEEPSEEK_API_KEY: "deepseek",
    GROQ_API_KEY: "groq",
    GEMINI_API_KEY: "gemini",
    OLLAMA_API_KEY: "ollama",
  };

  const providers = { ...config.providers };
  for (const [envVar, providerName] of Object.entries(envKeys)) {
    const key = Deno.env.get(envVar);
    if (key) {
      providers[providerName] = { ...providers[providerName], apiKey: key };
    }
  }

  return { ...config, providers };
}

export async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();

  if (!(await fileExists(configPath))) {
    throw new ConfigError(
      "CONFIG_NOT_FOUND",
      { path: configPath },
      "Run 'denoclaw onboard' to create the config file",
    );
  }

  try {
    const raw = await Deno.readTextFile(configPath);
    const parsed = normalizeConfig(JSON.parse(raw) as Config);
    log.debug("Config loaded", configPath);
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new ConfigError(
        "CONFIG_INVALID_JSON",
        { message: e.message },
        "Fix the JSON syntax in the config file",
      );
    }
    throw e;
  }
}

function cloneConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config;
}

function prepareConfigForPersistence(
  config: Config,
  options: SaveConfigOptions = {},
): Config {
  const persistable = normalizeConfig(cloneConfig(config));
  if (!options.persistAgentRegistry && persistable.agents) {
    delete persistable.agents.registry;
  }
  return persistable;
}

export async function saveConfig(
  config: Config,
  options: SaveConfigOptions = {},
): Promise<void> {
  const homeDir = getHomeDir();
  await ensureDir(homeDir);
  const configPath = getConfigPath();
  const persistable = prepareConfigForPersistence(config, options);
  await Deno.writeTextFile(configPath, JSON.stringify(persistable, null, 2));
  log.info("Config saved", configPath);
}

async function mergeWorkspaceAgents(config: Config): Promise<Config> {
  try {
    const wsRegistry = await WorkspaceLoader.buildRegistry();
    if (Object.keys(wsRegistry).length === 0) return config;

    const merged = { ...config };
    merged.agents = {
      ...merged.agents,
      registry: { ...(merged.agents.registry || {}), ...wsRegistry },
    };
    return merged;
  } catch {
    return config;
  }
}

export async function getConfig(): Promise<Config> {
  const config = await loadConfig();
  const withEnv = mergeEnvConfig(config);
  return mergeWorkspaceAgents(withEnv);
}

/**
 * Returns the raw persisted config file (or defaults when absent).
 *
 * Unlike getConfig()/getConfigOrDefault(), this does not merge environment
 * variables or workspace agents. It is only for legacy migration flows that
 * still need to inspect or clean up persisted registry state.
 */
export async function getPersistedConfigOrDefault(): Promise<Config> {
  try {
    return await loadConfig();
  } catch (e) {
    if (isConfigNotFoundError(e)) {
      log.debug("No persisted config found, using default values");
      return createDefaultConfig();
    }
    throw e;
  }
}

/**
 * Returns the resolved runtime config.
 *
 * This is the canonical read path for CLI/runtime behavior. It merges:
 * - persisted config
 * - environment provider overrides
 * - workspace agent declarations
 */
export async function getConfigOrDefault(): Promise<Config> {
  try {
    return await getConfig();
  } catch (e) {
    if (isConfigNotFoundError(e)) {
      log.debug("No config found, using default values");
      return mergeWorkspaceAgents(mergeEnvConfig(createDefaultConfig()));
    }
    throw e;
  }
}

export { createDefaultConfig };

function isConfigNotFoundError(error: unknown): error is ConfigError {
  return error instanceof ConfigError && error.code === "CONFIG_NOT_FOUND";
}

function normalizeConfig(config: Config): Config {
  const normalized = cloneConfig(config);
  if (normalized.agents?.registry) {
    normalized.agents.registry = normalizeAgentRegistry(
      normalized.agents.registry,
    );
  }
  if (normalized.channels?.telegram) {
    normalized.channels.telegram = normalizeTelegramConfig(
      normalized.channels.telegram as unknown as Record<string, unknown>,
    );
  }
  if (normalized.channels?.discord) {
    normalized.channels.discord = normalizeDiscordConfig(
      normalized.channels.discord as unknown as Record<string, unknown>,
    );
  }
  return normalized;
}

function normalizeAgentRegistry(
  registry: Record<string, AgentEntry>,
): Record<string, AgentEntry> {
  return Object.fromEntries(
    Object.entries(registry).map(([agentId, entry]) => [
      agentId,
      normalizeAgentEntry(entry),
    ]),
  );
}

function normalizeAgentEntry(entry: AgentEntry): AgentEntry {
  const normalized: Record<string, unknown> = { ...entry };
  delete normalized.channels;
  delete normalized.channelRouting;
  return normalized as AgentEntry;
}

function normalizeTelegramConfig(
  config: Record<string, unknown>,
): Config["channels"]["telegram"] {
  const legacyFields = getLegacyTelegramRootFields(config);
  if (legacyFields.length > 0) {
    throw new ConfigError(
      "CONFIG_INVALID",
      {
        channelType: "telegram",
        legacyFields,
      },
      "Move Telegram bot settings under channels.telegram.accounts[]",
    );
  }

  const accounts = normalizeTelegramAccounts(config);
  const enabled = typeof config.enabled === "boolean"
    ? config.enabled
    : accounts.length > 0;
  return {
    enabled,
    ...(accounts.length > 0 ? { accounts } : {}),
  };
}

function normalizeTelegramAccounts(
  config: Record<string, unknown>,
): Array<{
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
}> {
  const normalized: Array<{
    accountId: string;
    token?: string;
    tokenEnvVar?: string;
    allowFrom?: string[];
  }> = [];
  const seenAccountIds = new Set<string>();

  const rawAccounts = Array.isArray(config.accounts) ? config.accounts : [];
  for (const rawAccount of rawAccounts) {
    if (!rawAccount || typeof rawAccount !== "object") {
      throw new ConfigError(
        "CONFIG_INVALID",
        {
          channelType: "telegram",
          account: rawAccount,
        },
        "Each Telegram account entry must be an object under channels.telegram.accounts[]",
      );
    }
    const account = normalizeTelegramAccountRecord(
      rawAccount as Record<string, unknown>,
    );
    if (seenAccountIds.has(account.accountId)) {
      throw new ConfigError(
        "CONFIG_INVALID",
        {
          channelType: "telegram",
          accountId: account.accountId,
        },
        "Use a unique accountId for each Telegram bot under channels.telegram.accounts[]",
      );
    }
    seenAccountIds.add(account.accountId);
    normalized.push(account);
  }

  return normalized;
}

function normalizeTelegramAccountRecord(
  config: Record<string, unknown>,
): {
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
} {
  const accountId = normalizeString(config.accountId);
  if (!accountId) {
    throw new ConfigError(
      "CONFIG_INVALID",
      {
        channelType: "telegram",
        account: config,
      },
      "Set a non-empty Telegram accountId for each configured bot",
    );
  }

  const token = normalizeString(config.token);
  const tokenEnvVar = normalizeString(config.tokenEnvVar);
  const allowFrom = normalizeStringArray(config.allowFrom);

  return {
    accountId,
    ...(token ? { token } : {}),
    ...(tokenEnvVar ? { tokenEnvVar } : {}),
    ...(allowFrom ? { allowFrom } : {}),
  };
}

function getLegacyTelegramRootFields(
  config: Record<string, unknown>,
): string[] {
  const legacyFields: string[] = [];
  if (normalizeString(config.accountId)) legacyFields.push("accountId");
  if (normalizeString(config.token)) legacyFields.push("token");
  if (normalizeString(config.tokenEnvVar)) legacyFields.push("tokenEnvVar");
  if (normalizeStringArray(config.allowFrom)) legacyFields.push("allowFrom");
  return legacyFields;
}

function normalizeDiscordConfig(
  config: Record<string, unknown>,
): Config["channels"]["discord"] {
  const accounts = normalizeDiscordAccounts(config);
  const enabled = typeof config.enabled === "boolean"
    ? config.enabled
    : accounts.length > 0;
  return {
    enabled,
    ...(accounts.length > 0 ? { accounts } : {}),
  };
}

function normalizeDiscordAccounts(
  config: Record<string, unknown>,
): Array<{
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
}> {
  const normalized: Array<{
    accountId: string;
    token?: string;
    tokenEnvVar?: string;
    allowFrom?: string[];
  }> = [];
  const seenAccountIds = new Set<string>();

  const rawAccounts = Array.isArray(config.accounts) ? config.accounts : [];
  for (const rawAccount of rawAccounts) {
    if (!rawAccount || typeof rawAccount !== "object") {
      throw new ConfigError(
        "CONFIG_INVALID",
        {
          channelType: "discord",
          account: rawAccount,
        },
        "Each Discord account entry must be an object under channels.discord.accounts[]",
      );
    }
    const account = normalizeDiscordAccountRecord(
      rawAccount as Record<string, unknown>,
    );
    if (seenAccountIds.has(account.accountId)) {
      throw new ConfigError(
        "CONFIG_INVALID",
        {
          channelType: "discord",
          accountId: account.accountId,
        },
        "Use a unique accountId for each Discord bot under channels.discord.accounts[]",
      );
    }
    seenAccountIds.add(account.accountId);
    normalized.push(account);
  }

  return normalized;
}

function normalizeDiscordAccountRecord(
  config: Record<string, unknown>,
): {
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
} {
  const accountId = normalizeString(config.accountId);
  if (!accountId) {
    throw new ConfigError(
      "CONFIG_INVALID",
      {
        channelType: "discord",
        account: config,
      },
      "Set a non-empty Discord accountId for each configured bot",
    );
  }

  const token = normalizeString(config.token);
  const tokenEnvVar = normalizeString(config.tokenEnvVar);
  const allowFrom = normalizeStringArray(config.allowFrom);

  return {
    accountId,
    ...(token ? { token } : {}),
    ...(tokenEnvVar ? { tokenEnvVar } : {}),
    ...(allowFrom ? { allowFrom } : {}),
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}
