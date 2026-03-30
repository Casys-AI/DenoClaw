import { getConfigOrDefault, saveConfig } from "../../config/mod.ts";
import { requireInteractive } from "../output.ts";
import { ask, choose, confirm, error, print, success } from "../prompt.ts";

const PROVIDER_OPTIONS = [
  "anthropic  — Claude (API key)",
  "openai     — GPT (API key)",
  "ollama     — Ollama Cloud (API key)",
  "claude-cli — Claude Code CLI (local auth)",
  "codex-cli  — Codex CLI (local auth)",
  "openrouter — Multi-model gateway (API key)",
  "deepseek   — DeepSeek (API key)",
  "groq       — Groq (API key)",
  "gemini     — Google Gemini (API key)",
];

const NO_KEY_PROVIDERS = new Set(["claude-cli", "codex-cli"]);

export async function setupProvider(): Promise<void> {
  requireInteractive("denoclaw setup provider");
  const config = await getConfigOrDefault();

  const choice = await choose(
    "Which provider should be configured?",
    PROVIDER_OPTIONS,
  );
  const providerName = choice.split("—")[0].trim().split(/\s+/)[0];

  if (NO_KEY_PROVIDERS.has(providerName)) {
    if (providerName === "claude-cli" || providerName === "codex-cli") {
      const binary = providerName.replace("-cli", "");

      const check = new Deno.Command("which", {
        args: [binary],
        stdout: "piped",
        stderr: "piped",
      });
      const { success: found } = await check.output();
      if (!found) {
        error(`${binary} CLI not found.`);
        print(
          `  Install it: https://${
            binary === "claude" ? "claude.ai/download" : "openai.com/codex"
          }`,
        );
        return;
      }
      success(`${binary} CLI detected`);

      print(`\nChecking ${binary} authentication...`);
      const authCheck = new Deno.Command(binary, {
        args: binary === "claude" ? ["auth", "status"] : ["auth", "whoami"],
        stdout: "piped",
        stderr: "piped",
      });
      const { success: authed } = await authCheck.output();

      if (authed) {
        success(`${binary} CLI already authenticated`);
      } else {
        print(`\nStarting ${binary} authentication (opening browser)...\n`);
        const authCmd = new Deno.Command(binary, {
          args: ["auth", "login"],
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        });
        const { success: loginOk } = await authCmd.output();

        if (loginOk) {
          success(`${binary} CLI authenticated`);
        } else {
          error(
            `Failed to authenticate ${binary}. Retry manually: ${binary} auth login`,
          );
          return;
        }
      }

      config.providers[providerName] = { enabled: true };
      print(`\n  denoclaw agent --model ${providerName}`);
    } else {
      config.providers[providerName] = { enabled: true };
      print(`  denoclaw agent --model ${providerName}`);
    }
  } else {
    const key = await ask(`${providerName} API key`);
    if (!key) {
      error("Empty key, canceled.");
      return;
    }
    config.providers[providerName] = { apiKey: key, enabled: true };
  }

  if (await confirm(`Set ${providerName} as the default provider?`)) {
    const model = await ask("Default model", getDefaultModel(providerName));
    config.agents.defaults.model = model;
  }

  await saveConfig(config);
  success(`Provider ${providerName} configured.`);
}

export function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    anthropic: "anthropic/claude-sonnet-4-6",
    openai: "openai/gpt-4o",
    ollama: "ollama/nemotron-3-super",
    "claude-cli": "claude-cli",
    "codex-cli": "codex-cli",
    openrouter: "openrouter/anthropic/claude-sonnet-4-6",
    deepseek: "deepseek/deepseek-chat",
    groq: "groq/llama-3.3-70b-versatile",
    gemini: "gemini/gemini-2.0-flash",
  };
  return defaults[provider] || provider;
}
