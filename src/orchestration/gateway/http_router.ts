import type { Config } from "../../config/types.ts";
import type { SessionManager } from "../../messaging/session.ts";
import type { ChannelManager } from "../../messaging/channels/manager.ts";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import {
  createSSEResponse,
  getAgentStatus,
  listAgentStatuses,
  listCronJobs,
  listTaskObservations,
} from "../monitoring.ts";
import {
  getTrace,
  getTraceSpans,
  listAgentTraces,
} from "../../telemetry/traces.ts";
import type { RateLimiter } from "../rate_limit.ts";
import type { GitHubOAuth } from "../github_oauth.ts";
import type { AgentStore } from "../agent_store.ts";
import type { AgentEntry } from "../../shared/types.ts";
import { generateAllCards } from "../../messaging/a2a/card.ts";
import { getDashboardAuthMode } from "./dashboard_auth.ts";

export interface GatewayHttpContext {
  config: Config;
  session: SessionManager;
  channels: ChannelManager;
  workerPool: WorkerPool;
  metrics: MetricsCollector | null;
  kv: Deno.Kv | null;
  freshHandler: ((req: Request) => Promise<Response>) | null;
  dashboardBasePath: string;
  rateLimiter: RateLimiter | null;
  githubOAuth: GitHubOAuth | null;
  agentStore: AgentStore | null;
  checkAuth(req: Request): Promise<Response | null>;
  handleWebSocketUpgrade(req: Request): Promise<Response>;
}

export async function handleGatewayHttp(
  ctx: GatewayHttpContext,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);

  if (ctx.githubOAuth) {
    if (url.pathname === "/auth/github") {
      return await ctx.githubOAuth.handleAuthorize(req);
    }
    if (url.pathname === "/auth/github/callback") {
      return await ctx.githubOAuth.handleCallback(req);
    }
    if (url.pathname === "/auth/logout") {
      return await ctx.githubOAuth.handleLogout(req);
    }
  }

  if (
    ctx.freshHandler &&
    (url.pathname.startsWith(ctx.dashboardBasePath) ||
      url.pathname === ctx.dashboardBasePath ||
      url.pathname === "/favicon.ico")
  ) {
    if (
      getDashboardAuthMode() === "github-oauth" &&
      url.pathname !== `${ctx.dashboardBasePath}/login`
    ) {
      const user = ctx.githubOAuth
        ? await ctx.githubOAuth.verifySession(req)
        : null;
      if (!user) {
        const loginUrl = new URL(`${ctx.dashboardBasePath}/login`, url.origin);
        loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
        return Response.redirect(loginUrl.toString(), 302);
      }
    }

    return await ctx.freshHandler(req);
  }

  if (url.pathname === "/") {
    return new Response("DenoClaw Gateway");
  }

  if (ctx.rateLimiter) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const rl = await ctx.rateLimiter.check(ip);
    if (!rl.allowed) return ctx.rateLimiter.denyResponse(rl);
  }

  const authErr = await ctx.checkAuth(req);
  if (authErr) return authErr;

  if (
    ctx.agentStore && url.pathname === "/api/agents" && req.method === "GET"
  ) {
    const registry = await ctx.agentStore.list();
    return Response.json(registry);
  }

  if (
    ctx.agentStore && url.pathname === "/api/agents" && req.method === "POST"
  ) {
    try {
      const body = await req.json() as { agentId: string; config: AgentEntry };
      if (!body.agentId || !body.config) {
        return Response.json({
          error: {
            code: "INVALID_INPUT",
            recovery: "Provide agentId and config",
          },
        }, { status: 400 });
      }
      await ctx.agentStore.set(body.agentId, body.config);
      try {
        await ctx.workerPool.addAgent(body.agentId, body.config);
      } catch {
        // agent may already be running
      }
      return Response.json({ ok: true, agentId: body.agentId });
    } catch (e) {
      return Response.json({
        error: {
          code: "INVALID_JSON",
          context: { message: (e as Error).message },
        },
      }, { status: 400 });
    }
  }

  if (
    ctx.agentStore && url.pathname.startsWith("/api/agents/") &&
    req.method === "DELETE"
  ) {
    const agentId = url.pathname.split("/api/agents/")[1];
    if (!agentId) {
      return Response.json({ error: { code: "MISSING_AGENT_ID" } }, {
        status: 400,
      });
    }
    const deleted = await ctx.agentStore.delete(agentId);
    if (deleted) ctx.workerPool.removeAgent(agentId);
    return Response.json({ ok: deleted, agentId });
  }

  if (
    ctx.agentStore && url.pathname.startsWith("/api/agents/") &&
    req.method === "GET"
  ) {
    const agentId = url.pathname.split("/api/agents/")[1];
    const config = await ctx.agentStore.get(agentId);
    if (!config) {
      return Response.json({ error: { code: "AGENT_NOT_FOUND" } }, {
        status: 404,
      });
    }
    return Response.json({ agentId, config });
  }

  if (url.pathname === "/health") {
    return Response.json({
      status: "ok",
      channels: ctx.channels.getAllStatuses(),
      sessions: (await ctx.session.getActive()).length,
    });
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    try {
      const body = await req.json() as {
        message: string;
        sessionId?: string;
        model?: string;
        agentId: string;
      };

      if (!body.message || typeof body.message !== "string") {
        return Response.json(
          {
            error: {
              code: "INVALID_INPUT",
              context: { field: "message" },
              recovery: "Provide a non-empty 'message' string in the JSON body",
            },
          },
          { status: 400 },
        );
      }
      if (!body.agentId || typeof body.agentId !== "string") {
        return Response.json(
          {
            error: {
              code: "INVALID_INPUT",
              context: { field: "agentId" },
              recovery: "Provide 'agentId' in the JSON body",
            },
          },
          { status: 400 },
        );
      }

      const sessionId = body.sessionId || crypto.randomUUID();
      await ctx.session.getOrCreate(sessionId, "api", "http");

      const result = await ctx.workerPool.send(
        body.agentId,
        sessionId,
        body.message,
        {
          model: body.model,
        },
      );
      return Response.json({ sessionId, response: result.content });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json(
        {
          error: {
            code: "CHAT_FAILED",
            context: { message },
            recovery:
              "Check that the agent is configured and the payload is valid JSON",
          },
        },
        { status: 500 },
      );
    }
  }

  if (url.pathname === "/ws") {
    return await ctx.handleWebSocketUpgrade(req);
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

  if (url.pathname === "/events" && ctx.kv) {
    const agentIds = ctx.workerPool.getAgentIds();
    return createSSEResponse(ctx.kv, agentIds);
  }

  if (url.pathname === "/a2a/cards") {
    return Response.json(
      generateAllCards(ctx.config.agents, url.origin),
    );
  }

  if (url.pathname === "/agents/status") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
        status: 503,
      });
    }
    return Response.json(await listAgentStatuses(ctx.kv));
  }

  if (url.pathname.startsWith("/agents/") && url.pathname.endsWith("/status")) {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
        status: 503,
      });
    }
    const agentId = url.pathname.split("/")[2];
    const status = await getAgentStatus(ctx.kv, agentId);
    if (!status) {
      return Response.json({ error: { code: "AGENT_NOT_FOUND" } }, {
        status: 404,
      });
    }
    return Response.json(status);
  }

  if (url.pathname === "/tasks/observations") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
        status: 503,
      });
    }
    return Response.json(await listTaskObservations(ctx.kv));
  }

  if (url.pathname === "/cron/jobs") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
        status: 503,
      });
    }
    return Response.json(await listCronJobs(ctx.kv));
  }

  if (url.pathname === "/traces") {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
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
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
        status: 503,
      });
    }
    const traceId = url.pathname.split("/")[2];
    const trace = await getTrace(ctx.kv, traceId);
    if (!trace) {
      return Response.json({ error: { code: "TRACE_NOT_FOUND" } }, {
        status: 404,
      });
    }
    return Response.json(trace);
  }

  if (url.pathname.startsWith("/traces/") && url.pathname.endsWith("/spans")) {
    if (!ctx.kv) {
      return Response.json({ error: { code: "KV_UNAVAILABLE" } }, {
        status: 503,
      });
    }
    const traceId = url.pathname.split("/")[2];
    return Response.json(await getTraceSpans(ctx.kv, traceId));
  }

  return new Response("Not Found", { status: 404 });
}
