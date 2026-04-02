import type { Config } from "../../config/types.ts";
import type { ChannelManager } from "../../messaging/channels/manager.ts";
import { generateAllCards } from "../../messaging/a2a/card.ts";
import type { SessionManager } from "../../messaging/session.ts";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import {
  createSSEResponse,
  getAgentStatus,
  listAgentStatuses,
  listCronJobs,
  listTaskObservations,
} from "../monitoring.ts";
import { TaskStore } from "../../messaging/a2a/tasks.ts";
import {
  getTrace,
  getTraceSpans,
  listAgentTraces,
} from "../../telemetry/traces.ts";
import type { AnalyticsStore } from "../../db/analytics.ts";
import { handleGatewayAnalyticsRoute } from "./analytics_routes.ts";

export interface GatewayMonitoringRoutesContext {
  config: Config;
  session: Pick<SessionManager, "getActive">;
  channels: Pick<ChannelManager, "getAllStatuses">;
  workerPool: Pick<WorkerPool, "getAgentIds">;
  metrics: MetricsCollector | null;
  kv: Deno.Kv | null;
  analytics?: AnalyticsStore | null;
}

export async function handleGatewayMonitoringRoute(
  ctx: GatewayMonitoringRoutesContext,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/health") {
    return Response.json({
      status: "ok",
      channels: ctx.channels.getAllStatuses(),
      sessions: (await ctx.session.getActive()).length,
    });
  }

  if (url.pathname === "/stats" && ctx.metrics) {
    const agentId = url.searchParams.get("agent");
    if (agentId) {
      return Response.json(await ctx.metrics.getAgentMetrics(agentId));
    }
    return Response.json(await ctx.metrics.getSummary());
  }

  if (url.pathname === "/stats/agents" && ctx.metrics) {
    return Response.json(await ctx.metrics.getAllMetrics());
  }

  const analyticsRoute = await handleGatewayAnalyticsRoute(ctx, url);
  if (analyticsRoute) return analyticsRoute;

  if (url.pathname === "/events" && ctx.kv) {
    return createSSEResponse(ctx.kv, ctx.workerPool.getAgentIds());
  }

  if (url.pathname === "/a2a/cards") {
    return Response.json(generateAllCards(ctx.config.agents, url.origin));
  }

  if (url.pathname === "/agents/status") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    return Response.json(await listAgentStatuses(ctx.kv));
  }

  if (url.pathname.startsWith("/agents/") && url.pathname.endsWith("/status")) {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    const agentId = url.pathname.split("/")[2];
    const status = await getAgentStatus(ctx.kv, agentId);
    if (!status) {
      return Response.json({ error: { code: "AGENT_NOT_FOUND", recovery: "Register the agent before querying its status" } }, {
        status: 404,
      });
    }
    return Response.json(status);
  }

  if (url.pathname === "/tasks/observations") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    return Response.json(await listTaskObservations(ctx.kv));
  }

  if (url.pathname.startsWith("/tasks/context/")) {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    const contextId = url.pathname.slice("/tasks/context/".length);
    if (!contextId) {
      return Response.json({ error: { code: "MISSING_CONTEXT_ID", recovery: "Provide a contextId in the URL path" } }, {
        status: 400,
      });
    }
    const store = new TaskStore(ctx.kv);
    const tasks = await store.listByContext(decodeURIComponent(contextId));
    return Response.json(tasks);
  }

  if (url.pathname === "/cron/jobs") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    return Response.json(
      await listCronJobs(ctx.kv, url.searchParams.get("agent") ?? undefined),
    );
  }

  if (url.pathname === "/traces") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    const agentId = url.searchParams.get("agent");
    if (!agentId) {
      return Response.json({
        error: {
          code: "INVALID_INPUT",
          recovery: "Provide ?agent=<agentId> to list traces",
        },
      }, { status: 400 });
    }
    return Response.json(await listAgentTraces(ctx.kv, agentId));
  }

  if (url.pathname.startsWith("/traces/") && !url.pathname.endsWith("/spans")) {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    const traceId = url.pathname.split("/")[2];
    const trace = await getTrace(ctx.kv, traceId);
    if (!trace) {
      return Response.json({ error: { code: "TRACE_NOT_FOUND", recovery: "Verify the traceId exists via GET /traces?agent=<agentId>" } }, {
        status: 404,
      });
    }
    return Response.json(trace);
  }

  if (url.pathname.startsWith("/traces/") && url.pathname.endsWith("/spans")) {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE", recovery: "Check broker KV_PATH and Deno.openKv permissions" } }, {
        status: 503,
      });
    }
    const traceId = url.pathname.split("/")[2];
    return Response.json(await getTraceSpans(ctx.kv, traceId));
  }

  return null;
}
