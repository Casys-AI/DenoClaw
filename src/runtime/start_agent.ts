import type { Config } from "../config/types.ts";
import type { CliArgs } from "../cli/args.ts";
import { getResolvedAgentRegistry } from "../agent/registry.ts";
import { WorkerPool } from "../agent/worker_pool.ts";
import { ConsoleChannel } from "../messaging/channels/console.ts";
import { ChannelManager } from "../messaging/channels/manager.ts";
import { MessageBus } from "../messaging/bus.ts";
import { SessionManager } from "../messaging/session.ts";
import { log } from "../shared/log.ts";

export async function startAgentRuntime(
  config: Config,
  args: CliArgs,
): Promise<void> {
  const agentId = args.agent;
  const registry = getResolvedAgentRegistry(config);

  if (Object.keys(registry).length === 0) {
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

  const sessionId = args.session ?? "default";
  const agentIds = Object.keys(registry);

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
      const result = await pool.send(agentId, sessionId, args.message, {
        model: args.model,
      });
      console.log(result.content);
    } finally {
      pool.shutdown();
      agentKv.close();
    }
    return;
  }

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
        model: args.model,
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

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  await channels.startAll();

  ac.signal.addEventListener("abort", () => {
    pool.shutdown();
  });
}
