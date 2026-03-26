import type { Config } from "../types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { ask, choose, confirm, error, print, success } from "./prompt.ts";

// ── setup provider ──────────────────────────────────────

const PROVIDER_OPTIONS = [
  "anthropic  — Claude (API key)",
  "openai     — GPT (API key)",
  "ollama     — Local LLM (no key)",
  "claude-cli — Claude Code CLI (local auth)",
  "codex-cli  — Codex CLI (local auth)",
  "openrouter — Multi-model gateway (API key)",
  "deepseek   — DeepSeek (API key)",
  "groq       — Groq (API key)",
  "gemini     — Google Gemini (API key)",
];

const NO_KEY_PROVIDERS = new Set(["ollama", "claude-cli", "codex-cli"]);

export async function setupProvider(): Promise<void> {
  const config = await getConfigOrDefault();

  const choice = await choose("Quel provider configurer ?", PROVIDER_OPTIONS);
  const providerName = choice.split("—")[0].trim().split(/\s+/)[0];

  if (NO_KEY_PROVIDERS.has(providerName)) {
    if (providerName === "ollama") {
      const base = await ask("URL Ollama", "http://localhost:11434/v1");
      config.providers.ollama = { apiBase: base, enabled: true };
      print("\nPour utiliser Ollama :");
      print("  denoclaw agent --model ollama/nemotron-3-super");
    } else {
      config.providers[providerName] = { enabled: true };
      print(`\n${providerName} utilise l'auth locale du CLI.`);
      print(`  denoclaw agent --model ${providerName}`);
    }
  } else {
    const key = await ask(`Clé API ${providerName}`);
    if (!key) {
      error("Clé vide, annulé.");
      return;
    }
    config.providers[providerName] = { apiKey: key, enabled: true };
  }

  // Set as default model?
  if (await confirm(`Définir ${providerName} comme provider par défaut ?`)) {
    const model = await ask("Modèle par défaut", getDefaultModel(providerName));
    config.agents.defaults.model = model;
  }

  await saveConfig(config);
  success(`Provider ${providerName} configuré.`);
}

function getDefaultModel(provider: string): string {
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

// ── setup channel ───────────────────────────────────────

export async function setupChannel(): Promise<void> {
  const config = await getConfigOrDefault();

  const choice = await choose("Quel channel configurer ?", [
    "telegram  — Bot Telegram",
    "webhook   — Webhook HTTP générique",
  ]);
  const channelName = choice.split("—")[0].trim().split(/\s+/)[0];

  switch (channelName) {
    case "telegram": {
      const token = await ask("Token du bot Telegram (depuis @BotFather)");
      if (!token) {
        error("Token vide, annulé.");
        return;
      }

      const allowFrom = await ask("User IDs autorisés (virgule séparés, vide = tous)");
      config.channels.telegram = {
        enabled: true,
        token,
        allowFrom: allowFrom ? allowFrom.split(",").map((s) => s.trim()) : undefined,
      };

      success("Telegram configuré. Lancez le gateway :");
      print("  denoclaw gateway");
      break;
    }

    case "webhook": {
      const port = parseInt(await ask("Port", "8787"));
      const secret = await ask("Secret (header Authorization, vide = pas de secret)");
      config.channels.webhook = {
        enabled: true,
        port: port || 8787,
        secret: secret || undefined,
      };

      success(`Webhook configuré sur port ${port || 8787}.`);
      print("  denoclaw gateway");
      break;
    }
  }

  await saveConfig(config);
}

// ── setup agent ─────────────────────────────────────────

export async function setupAgent(): Promise<void> {
  const config = await getConfigOrDefault();

  print("\n=== Configuration de l'agent ===");

  const model = await ask("Modèle LLM", config.agents.defaults.model);
  config.agents.defaults.model = model;

  const temp = parseFloat(await ask("Température", String(config.agents.defaults.temperature)));
  if (!isNaN(temp)) config.agents.defaults.temperature = temp;

  const tokens = parseInt(await ask("Max tokens", String(config.agents.defaults.maxTokens)));
  if (!isNaN(tokens)) config.agents.defaults.maxTokens = tokens;

  const customPrompt = await ask("System prompt custom (vide = défaut)");
  if (customPrompt) config.agents.defaults.systemPrompt = customPrompt;

  if (await confirm("Restreindre les commandes shell au workspace ?", false)) {
    config.tools.restrictToWorkspace = true;
  }

  await saveConfig(config);
  success("Agent configuré.");
  print("  denoclaw agent       — chat interactif");
  print("  denoclaw agent -m .. — message unique");
}

// ── publish agent (Subhosting) ──────────────────────────

export async function publishAgent(): Promise<void> {
  print("\n=== Publier un agent sur Deno Subhosting ===");

  const orgId = await ask("Organization ID Subhosting");
  const token = await ask("Access token Subhosting");
  const projectName = await ask("Nom du projet", "denoclaw-agent");

  if (!orgId || !token) {
    error("Organization ID et token requis.");
    print("  Créez-les sur https://dash.deno.com/subhosting");
    return;
  }

  print("\nCréation du projet...");
  try {
    // Create project
    const projRes = await fetch(`https://api.deno.com/v1/organizations/${orgId}/projects`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: projectName }),
    });

    if (!projRes.ok) {
      const body = await projRes.text();
      error(`Échec création projet : ${projRes.status} ${body}`);
      return;
    }

    const project = await projRes.json() as { id: string; name: string };
    success(`Projet créé : ${project.name} (${project.id})`);

    print("\nPour déployer, poussez le code vers le projet :");
    print(`  deployctl deploy --project=${project.id}`);
    print("\nOu via l'API Subhosting :");
    print(`  POST /v1/projects/${project.id}/deployments`);
  } catch (e) {
    error(`Erreur : ${(e as Error).message}`);
  }
}

// ── publish gateway (Deploy) ────────────────────────────

export async function publishGateway(): Promise<void> {
  print("\n=== Déployer le gateway sur Deno Deploy ===");

  // Check if deployctl is available
  try {
    const cmd = new Deno.Command("deployctl", { args: ["--version"], stdout: "piped", stderr: "piped" });
    const { success: ok } = await cmd.output();
    if (!ok) throw new Error("not found");
  } catch {
    error("deployctl non installé.");
    print("  Installez-le : deno install -Arf jsr:@deno/deployctl");
    return;
  }

  const projectName = await ask("Nom du projet Deploy", "denoclaw-gateway");

  if (await confirm("Déployer main.ts comme gateway ?")) {
    print("\nDéploiement en cours...");
    const cmd = new Deno.Command("deployctl", {
      args: ["deploy", `--project=${projectName}`, "--prod", "main.ts"],
      stdout: "inherit",
      stderr: "inherit",
    });

    const { success: ok } = await cmd.output();
    if (ok) {
      success(`Gateway déployé sur https://${projectName}.deno.dev`);
      print("\nN'oubliez pas de configurer les env vars sur le dashboard :");
      print("  ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.");
    } else {
      error("Échec du déploiement. Vérifiez deployctl et votre auth.");
    }
  }
}

// ── status amélioré ─────────────────────────────────────

export async function showStatus(config: Config): Promise<void> {
  print("\n=== DenoClaw Status ===\n");

  // Providers
  const providers = Object.entries(config.providers)
    .filter(([_, v]) => v?.apiKey || v?.enabled)
    .map(([k, v]) => `${k}${v?.apiKey ? " (key)" : " (no-key)"}`);

  print(`Providers    : ${providers.join(", ") || "aucun"}`);
  print(`Modèle       : ${config.agents.defaults.model}`);
  print(`Température  : ${config.agents.defaults.temperature}`);
  print(`Max tokens   : ${config.agents.defaults.maxTokens}`);

  // Channels
  const channels = Object.entries(config.channels)
    .filter(([_, v]) => v && "enabled" in v && v.enabled)
    .map(([k]) => k);
  print(`Channels     : ${channels.join(", ") || "aucun"}`);

  // Tools
  print(`Workspace    : ${config.tools.restrictToWorkspace ? "restreint" : "libre"}`);

  // Sessions (KV)
  try {
    const { getSessionManager } = await import("../session/mod.ts");
    const sm = getSessionManager();
    const sessions = await sm.getActive();
    print(`Sessions     : ${sessions.length} active(s)`);
    sm.close();
  } catch {
    print(`Sessions     : KV non disponible`);
  }

  print("");
}
