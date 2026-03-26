#!/usr/bin/env -S deno run --unstable-kv --unstable-cron --allow-all

import { parseArgs } from "@std/cli/parse-args";
import { getConfig, getConfigOrDefault, saveConfig } from "./src/config/mod.ts";
import { AgentLoop } from "./src/agent/loop.ts";
import { Gateway } from "./src/gateway/mod.ts";
import { ConsoleChannel } from "./src/channels/console.ts";
import { getChannelManager } from "./src/channels/manager.ts";
import { getMessageBus } from "./src/bus/mod.ts";
import { getSessionManager } from "./src/session/mod.ts";
import { log } from "./src/utils/log.ts";
import { createDefaultConfig } from "./src/config/mod.ts";
import type { Config } from "./src/types.ts";

const args = parseArgs(Deno.args, {
  string: ["message", "session", "model"],
  alias: { m: "message", s: "session" },
  default: { session: "default" },
});

const command = args._[0] as string | undefined;

async function onboard(): Promise<void> {
  const config = createDefaultConfig();

  // Check for API keys in env
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");

  if (anthropicKey) {
    config.providers.anthropic = { apiKey: anthropicKey };
    log.info("Clé Anthropic détectée depuis l'environnement");
  }
  if (openaiKey) {
    config.providers.openai = { apiKey: openaiKey };
    log.info("Clé OpenAI détectée depuis l'environnement");
  }

  if (!anthropicKey && !openaiKey) {
    console.log("\nAucune clé API détectée. Définissez au moins une variable :");
    console.log("  export ANTHROPIC_API_KEY=sk-...");
    console.log("  export OPENAI_API_KEY=sk-...\n");
  }

  await saveConfig(config);
  console.log("Configuration initialisée. Lancez 'denoclaw agent' pour discuter.");
}

async function agent(config: Config): Promise<void> {
  const sessionId = args.session as string;

  if (args.message) {
    // Single message mode
    const loop = new AgentLoop(sessionId, config, args.model ? { model: args.model } : undefined);
    const result = await loop.processMessage(args.message as string);
    console.log(result.content);
    return;
  }

  // Interactive console mode
  const cm = getChannelManager();
  const bus = getMessageBus();
  await bus.init();
  const sm = getSessionManager();
  const console_ch = new ConsoleChannel();

  await console_ch.initialize();
  cm.register(console_ch);

  bus.subscribeAll(async (msg) => {
    await sm.getOrCreate(msg.sessionId, msg.userId, msg.channelType);
    const loop = new AgentLoop(msg.sessionId, config, args.model ? { model: args.model } : undefined);
    const result = await loop.processMessage(msg.content);
    await cm.send(msg.channelType, msg.userId, result.content, msg.metadata);
  });

  await cm.startAll();
}

async function gateway(config: Config): Promise<void> {
  const gw = new Gateway(config);
  await gw.start();

  // Wait for shutdown signal
  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    await gw.stop();
  }
}

async function status(): Promise<void> {
  try {
    const config = await getConfig();
    const providers = Object.entries(config.providers)
      .filter(([_, v]) => v?.apiKey)
      .map(([k]) => k);

    const sm = getSessionManager();
    const sessions = await sm.getActive();

    console.log("=== DenoClaw Status ===");
    console.log(`Providers configurés : ${providers.join(", ") || "aucun"}`);
    console.log(`Modèle par défaut    : ${config.agents.defaults.model}`);
    console.log(`Sessions actives     : ${sessions.length}`);
    console.log(`Channels configurés  : ${Object.keys(config.channels).join(", ") || "aucun"}`);
    sm.close();
  } catch (e) {
    console.error(`Erreur : ${(e as Error).message}`);
  }
}

function help(): void {
  console.log(`
DenoClaw — Agent IA Deno-natif

Usage:
  denoclaw onboard              Initialiser la configuration
  denoclaw agent                Chat interactif
  denoclaw agent -m "message"   Message unique
  denoclaw gateway              Lancer le gateway multi-canal
  denoclaw status               Voir l'état du système
  denoclaw help                 Afficher cette aide

Options:
  -m, --message    Envoyer un message unique
  -s, --session    ID de session (défaut: "default")
  --model          Surcharger le modèle LLM

Exemples:
  denoclaw agent -m "Bonjour, comment ça va ?"
  denoclaw agent --model openai/gpt-4o -m "Hello"
  ANTHROPIC_API_KEY=sk-... denoclaw agent
`);
}

// ── Main ──────────────────────────────────────────────────

try {
  switch (command) {
    case "onboard":
      await onboard();
      break;
    case "agent":
    case undefined: {
      const config = await getConfigOrDefault();
      await agent(config);
      break;
    }
    case "gateway": {
      const config = await getConfig();
      await gateway(config);
      break;
    }
    case "status":
      await status();
      break;
    case "help":
    default:
      help();
      break;
  }
} catch (e) {
  log.error("Erreur fatale", e);
  Deno.exit(1);
}
