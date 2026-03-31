import type { Config } from "../../config/types.ts";
import type { SessionManager } from "../../messaging/session.ts";
import type { ChannelManager } from "../../messaging/channels/manager.ts";
import type { BrokerChannelIngressClient } from "../channel_ingress/mod.ts";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import type { RateLimiter } from "../rate_limit.ts";
import type { GitHubOAuth } from "../github_oauth.ts";
import type { AgentStore } from "../agent_store.ts";
import {
  createChannelIngressMessage,
  getChannelTaskResponseText,
} from "../channel_ingress/mod.ts";
import { resolveGatewayInteractiveRoutePlan } from "./interactive_route.ts";
import { getDashboardAuthMode } from "./dashboard_auth.ts";
import { handleGatewayAgentRoute } from "./agent_routes.ts";
import { handleGatewayMonitoringRoute } from "./monitoring_routes.ts";

export interface GatewayHttpContext {
  config: Config;
  session: SessionManager;
  channels: ChannelManager;
  channelIngress: BrokerChannelIngressClient;
  workerPool: WorkerPool;
  metrics: MetricsCollector | null;
  kv: Deno.Kv | null;
  freshHandler: ((req: Request) => Promise<Response>) | null;
  dashboardBasePath: string;
  rateLimiter: RateLimiter | null;
  githubOAuth: GitHubOAuth | null;
  agentStore: AgentStore | null;
  checkAuth(req: Request): Promise<Response | null>;
  handleWebSocketUpgrade(req: Request): Response | Promise<Response>;
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

  const agentRoute = await handleGatewayAgentRoute(ctx, req, url);
  if (agentRoute) return agentRoute;

  if (req.method === "POST" && url.pathname === "/chat") {
    return await handleGatewayChatRoute(ctx, req);
  }

  if (url.pathname === "/ws") {
    return await ctx.handleWebSocketUpgrade(req);
  }

  const monitoringRoute = await handleGatewayMonitoringRoute(ctx, url);
  if (monitoringRoute) return monitoringRoute;

  return new Response("Not Found", { status: 404 });
}

async function handleGatewayChatRoute(
  ctx: Pick<GatewayHttpContext, "session" | "channelIngress">,
  req: Request,
): Promise<Response> {
  try {
    const body = await req.json() as {
      message: string;
      sessionId?: string;
      model?: string;
      agentId?: string;
      agentIds?: string[];
      delivery?: "direct" | "broadcast";
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
    const sessionId = body.sessionId || crypto.randomUUID();
    await ctx.session.getOrCreate(sessionId, "api", "http");
    const routePlan = resolveGatewayInteractiveRoutePlan(body);
    const submission = await ctx.channelIngress.submit(
      createChannelIngressMessage({
        channelType: "http",
        sessionId,
        userId: "api",
        content: body.message,
      }),
      routePlan,
    );
    return Response.json({
      sessionId,
      taskId: submission.taskId,
      task: submission.task,
      response: getChannelTaskResponseText(submission.task) ??
        `Task state: ${submission.task.status.state}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
