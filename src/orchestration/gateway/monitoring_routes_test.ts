import { assertEquals } from "@std/assert";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { ChannelManager } from "../../messaging/channels/manager.ts";
import type { SessionManager } from "../../messaging/session.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import type { Config } from "../../config/types.ts";
import { handleGatewayMonitoringRoute } from "./monitoring_routes.ts";

function createContext() {
  return {
    ctx: {
      config: {
        providers: {},
        agents: {
          defaults: { model: "test/model", temperature: 0.2, maxTokens: 256 },
          registry: { alice: { model: "test/model" } },
        },
        tools: {},
        channels: {},
      } as unknown as Config,
      session: {
        getActive: () => Promise.resolve([{ id: "session-1" }]),
      } as unknown as Pick<SessionManager, "getActive">,
      channels: {
        getAllStatuses: () => [{ name: "telegram", status: "running" }],
      } as unknown as Pick<ChannelManager, "getAllStatuses">,
      workerPool: {
        getAgentIds: () => ["alice"],
      } as unknown as Pick<WorkerPool, "getAgentIds">,
      metrics: {
        getSummary: () => Promise.resolve({ totalAgents: 1 }),
        getAgentMetrics: (agentId: string) => Promise.resolve({ agentId }),
        getAllMetrics: () => Promise.resolve({ alice: { requests: 1 } }),
      } as unknown as MetricsCollector,
      kv: null,
    },
  };
}

Deno.test("handleGatewayMonitoringRoute returns health summaries", async () => {
  const { ctx } = createContext();

  const res = await handleGatewayMonitoringRoute(
    ctx,
    new URL("http://localhost/health"),
  );

  assertEquals(res?.status, 200);
  assertEquals(await res?.json(), {
    status: "ok",
    channels: [{ name: "telegram", status: "running" }],
    sessions: 1,
  });
});

Deno.test("handleGatewayMonitoringRoute returns A2A cards", async () => {
  const { ctx } = createContext();

  const res = await handleGatewayMonitoringRoute(
    ctx,
    new URL("http://localhost/a2a/cards"),
  );

  assertEquals(res?.status, 200);
  const cards = await res?.json() as Record<string, { name: string }>;
  assertEquals(Object.keys(cards), ["alice"]);
  assertEquals(cards.alice?.name, "alice");
});

Deno.test("handleGatewayMonitoringRoute reports missing KV for status routes", async () => {
  const { ctx } = createContext();

  const res = await handleGatewayMonitoringRoute(
    ctx,
    new URL("http://localhost/agents/status"),
  );

  assertEquals(res?.status, 503);
  assertEquals(await res?.json(), {
    error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" },
  });
});
