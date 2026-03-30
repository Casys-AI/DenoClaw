import type { Config } from "./types.ts";
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
    const parsed = JSON.parse(raw) as Config;
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
  const persistable = cloneConfig(config);
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
    if (e instanceof ConfigError) {
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
    if (e instanceof ConfigError) {
      log.debug("No config found, using default values");
      return mergeWorkspaceAgents(mergeEnvConfig(createDefaultConfig()));
    }
    throw e;
  }
}

export { createDefaultConfig };
