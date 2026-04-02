import type { AuthManager } from "../auth.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import type { AgentEntry } from "../../shared/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { generateId } from "../../shared/helpers.ts";
import {
  requireDirectChannelIngressRoute,
  requireDirectChannelIngressRouteFromPlan,
} from "../channel_ingress/direct_route.ts";
import type { DirectChannelIngressRouteInput } from "../channel_ingress/types.ts";
import {
  type ChannelRoutePlan,
  createDirectChannelRoutePlan,
} from "../channel_routing/types.ts";
import { createSSEResponse, listCronJobs } from "../monitoring.ts";
import { handleGatewayAnalyticsRoute } from "../gateway/analytics_routes.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";
import type { BrokerAgentRegistry } from "./agent_registry.ts";
import {
  type BrokerFederationHttpContext,
  handleBrokerFederationHttpRoute,
} from "./federation_http_routes.ts";

export interface BrokerHttpContext extends BrokerFederationHttpContext {
  tunnelRegistry: TunnelRegistry;
  agentRegistry: BrokerAgentRegistry;
  metrics: MetricsCollector;
  getKv(): Promise<Deno.Kv>;
  getAuth(): Promise<AuthManager>;
  submitChannelMessage(
    message: ChannelMessage,
    input: {
      routePlan: ChannelRoutePlan;
      taskId: string;
    },
  ): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  continueChannelTask(
    message: ChannelMessage,
    taskId: string,
  ): Promise<Task | null>;
  handleAgentSocketUpgrade(req: Request): Promise<Response>;
  handleTunnelUpgrade(req: Request): Promise<Response>;
}

export async function handleBrokerHttp(
  ctx: BrokerHttpContext,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response("DenoClaw Broker");
  }

  if (url.pathname === "/health") {
    return Response.json({
      status: "ok",
      tunnels: ctx.tunnelRegistry.ids(),
      tunnelCount: ctx.tunnelRegistry.size,
    });
  }

  if (url.pathname === "/tunnel") {
    return await ctx.handleTunnelUpgrade(req);
  }

  if (url.pathname === "/agent/socket") {
    return await ctx.handleAgentSocketUpgrade(req);
  }

  if (req.method === "POST" && url.pathname === "/auth/invite") {
    const auth = await ctx.getAuth();
    const authResult = await auth.checkRequest(req);
    if (!authResult.ok) {
      return Response.json(
        {
          error: { code: authResult.code, recovery: authResult.recovery },
        },
        { status: 401 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as { tunnelId?: string };
    const invite = await auth.generateInviteToken(body.tunnelId);
    return Response.json({
      token: invite.token,
      expiresAt: invite.expiresAt,
    });
  }

  const auth = await ctx.getAuth();
  const authResult = await auth.checkRequest(req);
  if (!authResult.ok) {
    return Response.json(
      { error: { code: authResult.code, recovery: authResult.recovery } },
      { status: 401 },
    );
  }

  if (url.pathname === "/stats") {
    const agentId = url.searchParams.get("agent");
    if (agentId) {
      return Response.json(await ctx.metrics.getAgentMetrics(agentId));
    }
    return Response.json(await ctx.metrics.getSummary());
  }

  if (url.pathname === "/stats/agents") {
    return Response.json(await ctx.metrics.getAllMetrics());
  }

  if (url.pathname === "/cron/jobs") {
    const kv = await ctx.getKv();
    return Response.json(
      await listCronJobs(kv, url.searchParams.get("agent") ?? undefined),
    );
  }

  if (url.pathname === "/events") {
    const kv = await ctx.getKv();
    const agentIds = ctx.tunnelRegistry.collectAdvertisedAgentIds();
    return createSSEResponse(kv, agentIds);
  }

  if (req.method === "POST" && url.pathname === "/agents/register") {
    const body = (await req.json().catch(() => null)) as {
      agentId?: string;
      endpoint?: string;
      config?: AgentEntry;
    } | null;
    if (
      !body ||
      typeof body.agentId !== "string" ||
      body.agentId.length === 0 ||
      typeof body.endpoint !== "string" ||
      body.endpoint.length === 0
    ) {
      return Response.json(
        {
          error: {
            code: "INVALID_AGENT_REGISTRATION",
            recovery: "Provide { agentId, endpoint, config? }",
          },
        },
        { status: 400 },
      );
    }
    await ctx.agentRegistry.saveAgentEndpoint(body.agentId, body.endpoint);
    if (body.config) {
      await ctx.agentRegistry.saveAgentConfig(body.agentId, body.config);
    }
    return Response.json({ ok: true, agentId: body.agentId });
  }

  const agentConfigMatch = url.pathname.match(/^\/agents\/([^/]+)\/config$/);
  if (req.method === "GET" && agentConfigMatch) {
    const agentId = decodeURIComponent(agentConfigMatch[1]);
    const config = await ctx.agentRegistry.getAgentConfig(agentId);
    if (!config) {
      return Response.json(
        {
          error: {
            code: "AGENT_NOT_FOUND",
            recovery: "Register the agent with the broker before deploy boot",
          },
        },
        { status: 404 },
      );
    }
    return Response.json({ agentId, config });
  }

  if (req.method === "POST" && url.pathname === "/ingress/messages") {
    const body = (await req.json().catch(() => null)) as {
      message?: ChannelMessage;
      route?:
        | (DirectChannelIngressRouteInput & { taskId?: string })
        | ChannelRoutePlan;
      taskId?: string;
    } | null;
    const message = body?.message;
    if (!isChannelMessage(message)) {
      return Response.json(
        {
          error: {
            code: "INVALID_CHANNEL_MESSAGE",
            recovery:
              "Provide { message, route? } with a canonical channel message",
          },
        },
        { status: 400 },
      );
    }
    let routePlan: ChannelRoutePlan;
    try {
      routePlan = normalizeBrokerIngressRoutePlan(message, body?.route);
    } catch (error) {
      const structured = error instanceof DenoClawError
        ? error.toStructured()
        : {
          code: "CHANNEL_ROUTE_MISSING",
          recovery: error instanceof Error ? error.message : undefined,
        };
      return Response.json(
        {
          error: {
            code: structured.code,
            ...(structured.context ? { context: structured.context } : {}),
            recovery: structured.recovery ??
              "Provide a direct ingress target via route.agentId or message.metadata.agentId",
          },
        },
        { status: 400 },
      );
    }

    let task: Task;
    try {
      task = await ctx.submitChannelMessage(message, {
        routePlan,
        taskId: body?.taskId ||
          (hasTaskId(body?.route) ? body?.route.taskId : undefined) ||
          generateId(),
      });
    } catch (error) {
      return toStructuredBrokerErrorResponse(
        error,
        "Submit the ingress route with a valid direct or broadcast plan",
      );
    }
    return Response.json({ task });
  }

  const ingressTaskMatch = url.pathname.match(/^\/ingress\/tasks\/([^/]+)$/);
  if (req.method === "GET" && ingressTaskMatch) {
    return Response.json({
      task: await ctx.getTask(decodeURIComponent(ingressTaskMatch[1])),
    });
  }

  const ingressContinueMatch = url.pathname.match(
    /^\/ingress\/tasks\/([^/]+)\/continue$/,
  );
  if (req.method === "POST" && ingressContinueMatch) {
    const body = (await req.json().catch(() => null)) as {
      message?: ChannelMessage;
    } | null;
    if (!isChannelMessage(body?.message)) {
      return Response.json(
        {
          error: {
            code: "INVALID_CHANNEL_MESSAGE",
            recovery:
              "Provide { message } with the channel continuation payload",
          },
        },
        { status: 400 },
      );
    }

    try {
      return Response.json({
        task: await ctx.continueChannelTask(
          body.message,
          decodeURIComponent(ingressContinueMatch[1]),
        ),
      });
    } catch (error) {
      return toStructuredBrokerErrorResponse(
        error,
        "Resume the task through the same channel session and a supported delivery mode",
      );
    }
  }

  const analyticsResponse = await handleGatewayAnalyticsRoute({}, url);
  if (analyticsResponse) return analyticsResponse;

  const federationResponse = await handleBrokerFederationHttpRoute(
    ctx,
    req,
    url,
  );
  if (federationResponse) return federationResponse;

  return new Response("Not Found", { status: 404 });
}

function normalizeBrokerIngressRoutePlan(
  message: ChannelMessage,
  route:
    | (
      | (DirectChannelIngressRouteInput & { taskId?: string })
      | ChannelRoutePlan
    )
    | undefined,
): ChannelRoutePlan {
  if (!route) {
    const directRoute = requireDirectChannelIngressRouteFromPlan(message);
    return createDirectChannelRoutePlan(directRoute.agentId, {
      ...(directRoute.contextId ? { contextId: directRoute.contextId } : {}),
      ...(directRoute.metadata ? { metadata: directRoute.metadata } : {}),
    });
  }
  if (isChannelRoutePlan(route)) return route;
  const directRoute = requireDirectChannelIngressRoute(message, route);
  return createDirectChannelRoutePlan(directRoute.agentId, {
    ...(directRoute.contextId ? { contextId: directRoute.contextId } : {}),
    ...(directRoute.metadata ? { metadata: directRoute.metadata } : {}),
  });
}

function isChannelRoutePlan(value: unknown): value is ChannelRoutePlan {
  if (typeof value !== "object" || value === null) return false;
  const route = value as Record<string, unknown>;
  return (route.delivery === "direct" || route.delivery === "broadcast") &&
    Array.isArray(route.targetAgentIds);
}

function hasTaskId(
  value: unknown,
): value is DirectChannelIngressRouteInput & { taskId?: string } {
  return typeof value === "object" && value !== null && "taskId" in value;
}

function isChannelMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const address = message.address;
  return typeof message.id === "string" &&
    typeof message.sessionId === "string" &&
    typeof message.userId === "string" &&
    typeof message.content === "string" &&
    typeof message.channelType === "string" &&
    typeof message.timestamp === "string" &&
    typeof address === "object" &&
    address !== null &&
    typeof (address as Record<string, unknown>).channelType === "string";
}

function toStructuredBrokerErrorResponse(
  error: unknown,
  fallbackRecovery: string,
): Response {
  const structured = error instanceof DenoClawError ? error.toStructured() : {
    code: "BROKER_INGRESS_ERROR",
    recovery: error instanceof Error ? error.message : fallbackRecovery,
  };
  return Response.json(
    {
      error: {
        code: structured.code,
        ...(structured.context ? { context: structured.context } : {}),
        recovery: structured.recovery ?? fallbackRecovery,
      },
    },
    { status: 400 },
  );
}
