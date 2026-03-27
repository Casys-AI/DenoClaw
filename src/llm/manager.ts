import type { Config } from "../types.ts";
import type { LLMResponse, Message, ToolDefinition } from "../shared/types.ts";
import { AnthropicProvider, type BaseProvider, OpenAICompatProvider } from "./base.ts";
import { CLIProvider } from "./cli.ts";
import { OllamaProvider } from "./ollama.ts";
import { ProviderError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import { spanLLMCall } from "../telemetry/mod.ts";

interface ProviderEntry {
  name: string;
  prefixes: string[];
  requiresKey: boolean;
  factory: (apiKey: string, apiBase?: string) => BaseProvider;
}

const PROVIDERS: ProviderEntry[] = [
  {
    name: "anthropic",
    prefixes: ["anthropic/", "claude-"],
    requiresKey: true,
    factory: (k, b) => new AnthropicProvider(k, b),
  },
  {
    name: "openai",
    prefixes: ["openai/", "gpt-", "o1-", "o3-"],
    requiresKey: true,
    factory: (k, b) => new OpenAICompatProvider(k, b, "https://api.openai.com/v1"),
  },
  {
    name: "openrouter",
    prefixes: ["openrouter/"],
    requiresKey: true,
    factory: (k, b) => new OpenAICompatProvider(k, b, "https://openrouter.ai/api/v1"),
  },
  {
    name: "deepseek",
    prefixes: ["deepseek/", "deepseek-"],
    requiresKey: true,
    factory: (k, b) => new OpenAICompatProvider(k, b, "https://api.deepseek.com/v1"),
  },
  {
    name: "groq",
    prefixes: ["groq/"],
    requiresKey: true,
    factory: (k, b) => new OpenAICompatProvider(k, b, "https://api.groq.com/openai/v1"),
  },
  {
    name: "gemini",
    prefixes: ["gemini/", "gemini-"],
    requiresKey: true,
    factory: (k, b) => new OpenAICompatProvider(k, b, "https://generativelanguage.googleapis.com/v1beta/openai"),
  },
  {
    name: "ollama",
    prefixes: ["ollama/", "nemotron", "llama", "mistral", "phi", "qwen2", "codellama", "gemma"],
    requiresKey: true,
    factory: (k, b) => new OllamaProvider(k, b),
  },
  // CLI providers — shell out vers les CLI locaux
  {
    name: "claude-cli",
    prefixes: ["claude-cli"],
    requiresKey: false,
    factory: () => new CLIProvider("claude"),
  },
  {
    name: "codex-cli",
    prefixes: ["codex-cli"],
    requiresKey: false,
    factory: () => new CLIProvider("codex"),
  },
];

export class ProviderManager {
  private config: Config;
  private cache = new Map<string, BaseProvider>();

  constructor(config: Config) {
    this.config = config;
  }

  private resolveProvider(model: string): BaseProvider {
    const cached = this.cache.get(model);
    if (cached) return cached;

    for (const entry of PROVIDERS) {
      const matches = entry.prefixes.some((p) => model.startsWith(p));
      if (!matches) continue;

      if (entry.requiresKey) {
        const providerCfg = this.config.providers[entry.name];
        if (!providerCfg?.apiKey) continue;
        const provider = entry.factory(providerCfg.apiKey, providerCfg.apiBase);
        this.cache.set(model, provider);
        log.debug(`Provider résolu : ${entry.name} pour ${model}`);
        return provider;
      }

      // No key required (ollama, CLI)
      const providerCfg = this.config.providers[entry.name];
      const provider = entry.factory("", providerCfg?.apiBase);
      this.cache.set(model, provider);
      log.debug(`Provider résolu (no-key) : ${entry.name} pour ${model}`);
      return provider;
    }

    // Fallback: try any provider with a key
    for (const entry of PROVIDERS) {
      if (!entry.requiresKey) continue;
      const providerCfg = this.config.providers[entry.name];
      if (providerCfg?.apiKey && providerCfg.enabled !== false) {
        const provider = entry.factory(providerCfg.apiKey, providerCfg.apiBase);
        this.cache.set(model, provider);
        log.info(`Fallback provider : ${entry.name} pour ${model}`);
        return provider;
      }
    }

    throw new ProviderError(
      "NO_PROVIDER",
      { model, available: PROVIDERS.map((p) => p.name) },
      "Add an API key or use a no-key provider (ollama, claude-cli, codex-cli)",
    );
  }

  async complete(
    messages: Message[],
    model: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const provider = this.resolveProvider(model);
    const providerName = this.getProviderName(model);
    return await spanLLMCall(model, providerName, () =>
      provider.complete(messages, model, temperature, maxTokens, tools)
    );
  }

  private getProviderName(model: string): string {
    for (const entry of PROVIDERS) {
      if (entry.prefixes.some((p) => model.startsWith(p))) return entry.name;
    }
    return "unknown";
  }
}
