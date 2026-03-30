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
import {
  createBrokerServerDeps,
  createRelayToolExecutionPort,
} from "./src/orchestration/bootstrap.ts";
import { MetricsCollector } from "./src/telemetry/metrics.ts";
import {
  updateAgentsList,
  writeAgentStatus,
} from "./src/orchestration/monitoring.ts";
import { createAgent, deleteAgent, listAgents } from "./src/cli/agents.ts";
import { ask, confirm } from "./src/cli/prompt.ts";
import { initCliFlags } from "./src/cli/output.ts";
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
    "org",
    "app",
  ],
  boolean: ["force", "json", "yes"],
  alias: { m: "message", s: "session", a: "agent", y: "yes" },
  default: { session: "default" },
});

initCliFlags({ json: !!args.json, yes: !!args.yes });

const command = args._[0] as string | undefined;
const subcommand = args._[1] as string | undefined;

// ── Commands ──────────────────────────────────────────────

async function agent(config: Config): Promise<void> {
  const agentId = args.agent as string | undefined;
  const registry = config.agents?.registry;

  if (!registry || Object.keys(registry).length === 0) {
    console.log("No agents configured. Create one first:\n");
    console.log("  denoclaw agent create <name>\n");
    return;
  }

  if (!agentId) {
    const names = Object.keys(registry);
    console.log("Specify which agent to use with --agent <name>.\n");
    console.log(`  Available agents: ${names.join(", ")}\n`);
    console.log(`  Example: denoclaw agent -m "hello" --agent ${names[0]}\n`);
    return;
  }

  if (!registry[agentId]) {
    console.log(`Agent "${agentId}" not found.\n`);
    console.log(`  Available agents: ${Object.keys(registry).join(", ")}\n`);
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

  // DI: explicit wiring
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
      log.error("Message handling error", e);
      await channels.send(
        msg.channelType,
        msg.userId,
        "Sorry, an error occurred.",
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
  // DI: explicit wiring
  const agentIds = Object.keys(config.agents?.registry ?? {});
  if (agentIds.length === 0) {
    log.info(
      "No agents configured — starting the gateway in empty mode.",
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
  console.log("Step 1/3 — LLM provider\n");
  await setupProvider();

  // 2. Channel (optional)
  const wantChannel = await confirm(
    "Step 2/3 — Configure a channel (Telegram, webhook)?",
    false,
  );
  if (wantChannel) {
    await setupChannel();
  }

  // 3. Agent config
  const wantCustom = await confirm(
    "Step 3/3 — Customize the agent (model, temperature)?",
    false,
  );
  if (wantCustom) {
    await setupAgent();
  }

  console.log(`
✓ Setup complete!

To start:
  denoclaw agent              Interactive chat
  denoclaw agent -m "Hello"   One-off message
  denoclaw gateway            Multi-channel gateway
  denoclaw status             Show system status
`);
}

async function broker(config: Config): Promise<void> {
  const port = parseInt(args._[1] as string) || 3000;
  const srv = new BrokerServer(config, createBrokerServerDeps(config));
  await srv.start(port);

  console.log(`Broker started on port ${port}`);
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
    await ask("Broker WebSocket URL", "ws://localhost:3000/tunnel");
  const token = await ask("Invite token", "dev-token");

  const tools: string[] = ["shell", "read_file", "write_file"];

  console.log(`\nCapabilities:`);
  console.log(`  Tools: ${tools.join(", ")}`);

  const relay = new LocalRelay({
    brokerUrl,
    inviteToken: token,
    capabilities: { tools },
    autoApprove: true,
  }, {
    toolExecution: createRelayToolExecutionPort(tools),
  });

  await relay.connect();
  console.log("\nTunnel connected. Press Ctrl+C to disconnect.");

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    relay.disconnect();
    console.log("Tunnel disconnected.");
  }
}

function help(): void {
  console.log(`
DenoClaw — Agent IA Deno-natif

Workflow:
  denoclaw init                 Guided setup (provider + channel + agent)
  denoclaw dev                  Work locally (gateway + agents + dashboard)
  denoclaw deploy               Deploy/update the broker on Deno Deploy
  denoclaw publish [agent]      Push agent(s) to the remote broker
  denoclaw status               Show local + remote status
  denoclaw logs                 Stream broker logs

Agents:
  denoclaw agent list           List all agents
  denoclaw agent create <name>  Create an agent
  denoclaw agent delete <name>  Delete an agent

Advanced:
  denoclaw tunnel [url]         Connect a local tunnel to the broker

Options:
  -m, --message    Send a one-off message (with dev --agent)
  -s, --session    Session ID (default: "default")
  -a, --agent      Target agent
  --model          Override the LLM model
  --org            Deno Deploy organization
  --app            Deno Deploy app name
  --json           Structured JSON output (AX mode)
  --yes, -y        Skip all confirmations
`);
}

// ── Main ──────────────────────────────────────────────────

try {
  switch (command) {
    case "setup":
      console.log("⚠ 'denoclaw setup' is deprecated. Use 'denoclaw init' instead.\n");
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
    case "publish":
      if (subcommand === "agent") {
        await publishAgent();
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
        console.log("No provider configured. Starting initial setup.\n");
        await init();
        break;
      }
      await agent(config);
      break;
    }

    case "dev": {
      const config = await getConfig();
      if (args.agent) {
        await agent(config);
      } else {
        await gateway(config);
      }
      break;
    }

    case undefined: {
      // On Deno Deploy: auto-start gateway
      if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
        const config = await getConfigOrDefault();
        await gateway(config);
        break;
      }

      // Locally: show help
      help();
      break;
    }

    case "gateway": {
      console.log("⚠ 'denoclaw gateway' is deprecated. Use 'denoclaw dev' instead.\n");
      const config = await getConfig();
      await gateway(config);
      break;
    }

    case "broker": {
      console.log("⚠ 'denoclaw broker' is deprecated. Use 'denoclaw deploy' for production.\n");
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
  log.error("Fatal error", e);
  Deno.exit(1);
}
