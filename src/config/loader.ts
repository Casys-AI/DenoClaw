import type { Config } from "./types.ts";
import { ConfigError, ensureDir, fileExists, getConfigPath, getHomeDir, log } from "../shared/mod.ts";

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
    log.debug("Config chargée", configPath);
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new ConfigError("CONFIG_INVALID_JSON", { message: e.message }, "Fix the JSON syntax in the config file");
    }
    throw e;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const homeDir = getHomeDir();
  await ensureDir(homeDir);
  const configPath = getConfigPath();
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
  log.info("Config sauvegardée", configPath);
}

export async function getConfig(): Promise<Config> {
  const config = await loadConfig();
  return mergeEnvConfig(config);
}

export async function getConfigOrDefault(): Promise<Config> {
  try {
    return await getConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log.debug("Pas de config, utilisation des valeurs par défaut");
      return mergeEnvConfig(createDefaultConfig());
    }
    throw e;
  }
}

export { createDefaultConfig };
