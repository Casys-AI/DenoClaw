#!/usr/bin/env -S deno run --unstable-kv --unstable-cron --allow-all --env

import { parseArgs } from "@std/cli/parse-args";
import { getConfig, getConfigOrDefault } from "./src/config/loader.ts";
import type { Config } from "./src/config/types.ts";
import { WorkerPool } from "./src/agent/worker_pool.ts";
import { Gateway } from "./src/orchestration/gateway.ts";
import { ConsoleChannel } from "./src/messaging/channels/console.ts";
import { ChannelManager } from "./src/messaging/channels/manager.ts";
import { MessageBus } from "./src/messaging/bus.ts";
import { SessionManager } from "./src/messaging/session.ts";
import {
  publishAgent,
  setupAgent,
  setupChannel,
  setupProvider,
  showStatus,
} from "./src/cli/setup.ts";
import { BrokerServer } from "./src/orchestration/broker.ts";
import { LocalRelay } from "./src/orchestration/relay.ts";
import { MetricsCollector } from "./src/telemetry/metrics.ts";
import {
  updateAgentsList,
  writeAgentStatus,
} from "./src/orchestration/monitoring.ts";
import { createAgent, deleteAgent, listAgents } from "./src/cli/agents.ts";
import { ask, confirm } from "./src/cli/prompt.ts";
import { log } from "./src/shared/log.ts";
import { createDashboardHandler } from "./web/mod.ts";

const args = parseArgs(Deno.args, {
  string: [
    "message",
    "session",
    "model",
    "agent",
    "description",
    "system-prompt",
    "permissions",
    "peers",
    "accept-from",
  ],
  boolean: ["force"],
  alias: { m: "message", s: "session", a: "agent" },
  default: { session: "default" },
});

const command = args._[0] as string | undefined;
const subcommand = args._[1] as string | undefined;

// ── Commands ──────────────────────────────────────────────

async function agent(config: Config): Promise<void> {
  const agentId = args.agent as string | undefined;
  const registry = config.agents?.registry;

  if (!registry || Object.keys(registry).length === 0) {
    console.log("Aucun agent configuré. Créez-en un d'abord :\n");
    console.log("  denoclaw agent create <nom>\n");
    return;
  }

  if (!agentId) {
    const names = Object.keys(registry);
    console.log("Précise quel agent utiliser avec --agent <nom>.\n");
    console.log(`  Agents disponibles : ${names.join(", ")}\n`);
    console.log(`  Exemple : denoclaw agent -m "hello" --agent ${names[0]}\n`);
    return;
  }

  if (!registry[agentId]) {
    console.log(`Agent "${agentId}" introuvable.\n`);
    console.log(`  Agents disponibles : ${Object.keys(registry).join(", ")}\n`);
    return;
  }

  const sessionId = args.session as string;
  const agentIds = Object.keys(registry);

  // Shared KV for agent command path — same as gateway, enables observability
  await Deno.mkdir("./data", { recursive: true });
  const agentKv = await Deno.openKv("./data/shared.db");

  const pool = new WorkerPool(config, {
    onAgentMessage: (from, to, message) => {
      log.debug(`Agent message: ${from} → ${to} (${message.slice(0, 50)}...)`);
    },
  });
  pool.setSharedKv(agentKv);
  await pool.start(agentIds);

  if (args.message) {
    try {
      const result = await pool.send(
        agentId,
        sessionId,
        args.message as string,
        {
          model: args.model as string | undefined,
        },
      );
      console.log(result.content);
    } finally {
      pool.shutdown();
      agentKv.close();
    }
    return;
  }

  // DI : wiring explicite
  const bus = new MessageBus(agentKv);
  await bus.init();
  const session = new SessionManager(agentKv);
  const channels = new ChannelManager(bus);
  const consoleCh = new ConsoleChannel();

  await consoleCh.initialize();
  channels.register(consoleCh);

  bus.subscribeAll(async (msg) => {
    await session.getOrCreate(msg.sessionId, msg.userId, msg.channelType);
    try {
      const result = await pool.send(agentId, msg.sessionId, msg.content, {
        model: args.model as string | undefined,
      });
      await channels.send(
        msg.channelType,
        msg.userId,
        result.content,
        msg.metadata,
      );
    } catch (e) {
      log.error("Erreur traitement message", e);
      await channels.send(
        msg.channelType,
        msg.userId,
        "Désolé, une erreur s'est produite.",
        msg.metadata,
      );
    }
  });

  // Graceful shutdown
  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  await channels.startAll();

  ac.signal.addEventListener("abort", () => {
    pool.shutdown();
  });
}

async function gateway(config: Config): Promise<void> {
  // DI : wiring explicite
  const agentIds = Object.keys(config.agents?.registry ?? {});
  if (agentIds.length === 0) {
    log.info(
      "Aucun agent configuré — démarrage du gateway en mode vide.",
    );
  }

  // Shared KV — single instance for metrics, agent status, dashboard.
  // On Deploy use the platform KV; locally keep the file-backed DB for dev.
  let kv: Deno.Kv;
  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    kv = await Deno.openKv();
  } else {
    await Deno.mkdir("./data", { recursive: true });
    kv = await Deno.openKv("./data/shared.db");
  }
  const metrics = new MetricsCollector(kv);

  // WorkerPool with lifecycle callbacks → writes agent status to shared KV
  const workerPool = new WorkerPool(config, {
    onWorkerReady: (id) => {
      void writeAgentStatus(kv, id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    },
    onWorkerStopped: (id) => {
      void writeAgentStatus(kv, id, {
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      });
    },
    onAgentMessage: (from, to, message) => {
      void metrics.recordAgentMessage(from, to);
      log.debug(
        `Agent message routed: ${from} → ${to} (${message.slice(0, 50)}...)`,
      );
    },
  });
  workerPool.setSharedKv(kv);
  await workerPool.start(agentIds);
  await updateAgentsList(kv, workerPool.getAgentIds());

  const bus = new MessageBus(kv);
  const session = new SessionManager(kv);
  const channels = new ChannelManager(bus);
  const dashboardBasePath = Deno.env.get("DENOCLAW_DASHBOARD_BASE_PATH") ||
    "/ui";
  const freshHandler = createDashboardHandler(dashboardBasePath);
  const gw = new Gateway(config, {
    bus,
    session,
    channels,
    workerPool,
    metrics,
    kv: kv ?? undefined,
    dashboardBasePath,
    freshHandler: async (req) => await freshHandler(req),
  });
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
    workerPool.shutdown();
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
  const wantChannel = await confirm(
    "Étape 2/3 — Configurer un channel (Telegram, webhook) ?",
    false,
  );
  if (wantChannel) {
    await setupChannel();
  }

  // 3. Agent config
  const wantCustom = await confirm(
    "Étape 3/3 — Personnaliser l'agent (modèle, température) ?",
    false,
  );
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
  const brokerUrl = args._[1] as string ||
    await ask("URL du broker WebSocket", "ws://localhost:3000/tunnel");
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

    case "deploy":
      if (subcommand === "agent") {
        const agentName = args._[2] as string;
        const brokerUrl = (args.broker as string) || Deno.env.get("DENOCLAW_BROKER_URL");
        await publishAgent(agentName, { brokerUrl });
      } else {
        console.log("Usage: denoclaw deploy agent <name> --broker <url>");
      }
      break;

    // Legacy alias
    case "publish":
      if (subcommand === "agent") {
        const agentName = args._[2] as string;
        const brokerUrl = (args.broker as string) || Deno.env.get("DENOCLAW_BROKER_URL");
        await publishAgent(agentName, { brokerUrl });
      } else {
        console.log("Usage: denoclaw deploy agent <name> --broker <url>");
      }
      break;

    case "init": {
      await init();
      break;
    }

    case "agent": {
      if (subcommand === "list") {
        await listAgents();
        break;
      }
      if (subcommand === "create") {
        await createAgent(args._[2] as string, {
          description: args.description as string | undefined,
          model: args.model as string | undefined,
          systemPrompt: args["system-prompt"] as string | undefined,
          permissions: args.permissions as string | undefined,
          peers: args.peers as string | undefined,
          acceptFrom: args["accept-from"] as string | undefined,
          force: !!args.force,
        });
        break;
      }
      if (subcommand === "delete") {
        await deleteAgent(args._[2] as string, { yes: !!args.yes || !!args.y });
        break;
      }

      const config = await getConfigOrDefault();
      const hasProvider = Object.values(config.providers).some((p) =>
        p?.apiKey || p?.enabled
      );
      if (!hasProvider) {
        console.log("Aucun provider configuré. Lançons la config initiale.\n");
        await init();
        break;
      }
      await agent(config);
      break;
    }

    case undefined: {
      // On Deno Deploy: auto-start gateway (no CLI, no interactive mode)
      if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
        const config = await getConfigOrDefault();
        await gateway(config);
        break;
      }

      const config2 = await getConfigOrDefault();
      const hasProvider2 = Object.values(config2.providers).some((p) =>
        p?.apiKey || p?.enabled
      );
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
