import type { Config } from "../config/types.ts";
import { getResolvedAgentRegistry } from "../agent/registry.ts";
import { WorkerPool } from "../agent/worker_pool.ts";
import { Gateway } from "../orchestration/gateway/server.ts";
import { MessageBus } from "../messaging/bus.ts";
import { SessionManager } from "../messaging/session.ts";
import { ChannelManager } from "../messaging/channels/manager.ts";
import { MetricsCollector } from "../telemetry/metrics.ts";
import {
  updateAgentsList,
  writeAgentStatus,
} from "../orchestration/monitoring.ts";
import { log } from "../shared/log.ts";
import { createDashboardHandler } from "../../web/mod.ts";

export async function startLocalGateway(config: Config): Promise<void> {
  const agentIds = Object.keys(getResolvedAgentRegistry(config));
  if (agentIds.length === 0) {
    log.info("No agents configured — starting the gateway in empty mode.");
  }

  let kv: Deno.Kv;
  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    kv = await Deno.openKv();
  } else {
    await Deno.mkdir("./data", { recursive: true });
    kv = await Deno.openKv("./data/shared.db");
  }
  const metrics = new MetricsCollector(kv);

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
  const gateway = new Gateway(config, {
    bus,
    session,
    channels,
    workerPool,
    metrics,
    kv: kv ?? undefined,
    dashboardBasePath,
    freshHandler: async (req) => await freshHandler(req),
  });
  await gateway.start();

  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());

  try {
    await new Promise((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new Error("shutdown")));
    });
  } catch {
    await gateway.stop();
    workerPool.shutdown();
  }
}
