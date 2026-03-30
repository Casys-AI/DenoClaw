import type { AuthManager } from "../auth.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import type { AgentEntry } from "../../shared/types.ts";
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

  const federationResponse = await handleBrokerFederationHttpRoute(
    ctx,
    req,
    url,
  );
  if (federationResponse) return federationResponse;

  return new Response("Not Found", { status: 404 });
}
