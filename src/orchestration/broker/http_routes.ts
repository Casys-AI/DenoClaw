import type { AuthManager } from "../auth.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import type { AgentEntry } from "../../shared/types.ts";
import { generateId } from "../../shared/helpers.ts";
import { createSSEResponse } from "../monitoring.ts";
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
      targetAgent: string;
      taskId: string;
      contextId?: string;
      metadata?: Record<string, unknown>;
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

  if (req.method === "POST" && url.pathname === "/ingress/messages") {
    const body = (await req.json().catch(() => null)) as {
      message?: ChannelMessage;
      route?: {
        agentId?: string;
        taskId?: string;
        contextId?: string;
        metadata?: Record<string, unknown>;
      };
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
    const routeAgentId = body?.route?.agentId ??
      (
        typeof message.metadata?.agentId === "string"
          ? message.metadata.agentId
          : undefined
      );
    if (!routeAgentId) {
      return Response.json(
        {
          error: {
            code: "CHANNEL_ROUTE_MISSING",
            recovery: "Provide route.agentId or message.metadata.agentId",
          },
        },
        { status: 400 },
      );
    }

    const task = await ctx.submitChannelMessage(message, {
      targetAgent: routeAgentId,
      taskId: body?.route?.taskId || generateId(),
      contextId: body?.route?.contextId,
      metadata: body?.route?.metadata,
    });
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

    return Response.json({
      task: await ctx.continueChannelTask(
        body.message,
        decodeURIComponent(ingressContinueMatch[1]),
      ),
    });
  }

  const federationResponse = await handleBrokerFederationHttpRoute(
    ctx,
    req,
    url,
  );
  if (federationResponse) return federationResponse;

  return new Response("Not Found", { status: 404 });
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
