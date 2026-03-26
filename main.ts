#!/usr/bin/env -S deno run --unstable-kv --unstable-cron --allow-all

import { parseArgs } from "@std/cli/parse-args";
import { getConfig, getConfigOrDefault } from "./src/config/mod.ts";
import { AgentLoop } from "./src/agent/loop.ts";
import { Gateway } from "./src/gateway/mod.ts";
import { ConsoleChannel } from "./src/channels/console.ts";
import { getChannelManager } from "./src/channels/manager.ts";
import { getMessageBus } from "./src/bus/mod.ts";
import { getSessionManager } from "./src/session/mod.ts";
import {
  publishAgent,
  publishGateway,
  setupAgent,
  setupChannel,
  setupProvider,
  showStatus,
} from "./src/cli/setup.ts";
import { BrokerServer } from "./src/broker/server.ts";
import { LocalRelay } from "./src/relay/local.ts";
import { createAgent, deleteAgent, listAgents } from "./src/cli/agents.ts";
import { ask, confirm } from "./src/cli/prompt.ts";
import { log } from "./src/utils/log.ts";
import type { Config } from "./src/types.ts";

const args = parseArgs(Deno.args, {
  string: ["message", "session", "model"],
  alias: { m: "message", s: "session" },
  default: { session: "default" },
});

const command = args._[0] as string | undefined;
const subcommand = args._[1] as string | undefined;

// ── Commands ──────────────────────────────────────────────

async function agent(config: Config): Promise<void> {
  const sessionId = args.session as string;

  if (args.message) {
    const loop = new AgentLoop(sessionId, config, args.model ? { model: args.model } : undefined);
    const result = await loop.processMessage(args.message as string);
    console.log(result.content);
    return;
  }

  const cm = getChannelManager();
  const bus = getMessageBus();
  await bus.init();
  const sm = getSessionManager();
  const consoleCh = new ConsoleChannel();

  await consoleCh.initialize();
  cm.register(consoleCh);

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

async function init(): Promise<void> {
  console.log(`
╔═══════════════════════════════════╗
║        DenoClaw — Setup           ║
╚═══════════════════════════════════╝
`);

  // 1. Provider
  console.log("Étape 1/3 — Provider LLM\n");
  await setupProvider();

  // 2. Channel (optionnel)
  const wantChannel = await confirm("Étape 2/3 — Configurer un channel (Telegram, webhook) ?", false);
  if (wantChannel) {
    await setupChannel();
  }

  // 3. Agent config
  const wantCustom = await confirm("Étape 3/3 — Personnaliser l'agent (modèle, température) ?", false);
  if (wantCustom) {
    await setupAgent();
  }

  console.log(`
✓ Configuration terminée !

Pour démarrer :
  denoclaw agent              Chat interactif
  denoclaw agent -m "Hello"   Message unique
  denoclaw gateway            Gateway multi-canal
  denoclaw status             Voir l'état
`);
}

async function broker(config: Config): Promise<void> {
  const port = parseInt(args._[1] as string) || 3000;
  const srv = new BrokerServer(config);
  await srv.start(port);

  console.log(`Broker démarré sur port ${port}`);
  console.log(`  Health: http://localhost:${port}/health`);
  console.log(`  Tunnel: ws://localhost:${port}/tunnel`);

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    await srv.stop();
  }
}

async function tunnel(): Promise<void> {
  const brokerUrl = args._[1] as string || await ask("URL du broker WebSocket", "ws://localhost:3000/tunnel");
  const token = await ask("Token d'invitation", "dev-token");

  const tools: string[] = ["shell", "read_file", "write_file"];

  console.log(`\nCapabilities:`);
  console.log(`  Tools: ${tools.join(", ")}`);

  const relay = new LocalRelay({
    brokerUrl,
    inviteToken: token,
    capabilities: { tools },
    autoApprove: true,
  });

  await relay.connect();
  console.log("\nTunnel connecté. Ctrl+C pour déconnecter.");

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    relay.disconnect();
    console.log("Tunnel déconnecté.");
  }
}

function help(): void {
  console.log(`
DenoClaw — Agent IA Deno-natif

Démarrage:
  denoclaw init               Setup guidé (provider + channel + agent)

Setup:
  denoclaw setup provider     Configurer un provider LLM
  denoclaw setup channel      Configurer un channel (Telegram, webhook)
  denoclaw setup agent        Configurer l'agent (modèle, température, etc.)

Agents:
  denoclaw agent              Chat interactif (agent par défaut)
  denoclaw agent -m "msg"     Message unique
  denoclaw agent list         Lister tous les agents
  denoclaw agent create <nom> Créer un agent (modèle, permissions, channel)
  denoclaw agent delete <nom> Supprimer un agent

Usage:
  denoclaw gateway            Lancer le gateway multi-canal
  denoclaw status             Voir l'état du système

Infra:
  denoclaw broker             Lancer le broker (LLM proxy + message router)
  denoclaw tunnel             Connecter un tunnel local au broker

Publish:
  denoclaw publish agent      Déployer un agent sur Deno Subhosting
  denoclaw publish gateway    Déployer le gateway sur Deno Deploy

Options:
  -m, --message    Envoyer un message unique
  -s, --session    ID de session (défaut: "default")
  --model          Surcharger le modèle LLM

Exemples:
  denoclaw setup provider                      # configurer Anthropic, Ollama, etc.
  denoclaw setup channel                       # configurer Telegram
  denoclaw agent -m "Bonjour"                  # message unique
  denoclaw agent --model ollama/nemotron-3-super       # utiliser Ollama
  denoclaw agent --model claude-cli            # utiliser Claude Code CLI
  denoclaw gateway                             # lancer le serveur multi-canal
  denoclaw publish gateway                     # déployer sur Deno Deploy
`);
}

// ── Main ──────────────────────────────────────────────────

try {
  switch (command) {
    case "setup":
      switch (subcommand) {
        case "provider":
          await setupProvider();
          break;
        case "channel":
          await setupChannel();
          break;
        case "agent":
          await setupAgent();
          break;
        default:
          console.log("Usage: denoclaw setup [provider|channel|agent]");
          break;
      }
      break;

    case "publish":
      switch (subcommand) {
        case "agent":
          await publishAgent();
          break;
        case "gateway":
          await publishGateway();
          break;
        default:
          console.log("Usage: denoclaw publish [agent|gateway]");
          break;
      }
      break;

    case "init": {
      await init();
      break;
    }

    case "agent": {
      // Sub-commands: list, create, delete
      if (subcommand === "list") { await listAgents(); break; }
      if (subcommand === "create") { await createAgent(args._[2] as string); break; }
      if (subcommand === "delete") { await deleteAgent(args._[2] as string); break; }

      // Default: run agent (chat)
      const config = await getConfigOrDefault();
      const hasProvider = Object.values(config.providers).some((p) => p?.apiKey || p?.enabled);
      if (!hasProvider) {
        console.log("Aucun provider configuré. Lançons la config initiale.\n");
        await init();
        break;
      }
      await agent(config);
      break;
    }

    case undefined: {
      const config2 = await getConfigOrDefault();
      const hasProvider2 = Object.values(config2.providers).some((p) => p?.apiKey || p?.enabled);
      if (!hasProvider2) {
        console.log("Aucun provider configuré. Lançons la config initiale.\n");
        await init();
        break;
      }
      await agent(config2);
      break;
    }

    case "gateway": {
      const config = await getConfig();
      await gateway(config);
      break;
    }

    case "broker": {
      const config = await getConfig();
      await broker(config);
      break;
    }

    case "tunnel": {
      await tunnel();
      break;
    }

    case "status": {
      const config = await getConfigOrDefault();
      await showStatus(config);
      break;
    }

    case "help":
    default:
      help();
      break;
  }
} catch (e) {
  log.error("Erreur fatale", e);
  Deno.exit(1);
}
