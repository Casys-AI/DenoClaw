import type { FreshContext } from "@fresh/core";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../../lib/dashboard-auth.ts";

export const handler = {
  async GET(ctx: FreshContext) {
    return await proxyAgentsRequest(ctx);
  },

  async POST(ctx: FreshContext) {
    return await proxyAgentsRequest(ctx);
  },
};

async function proxyAgentsRequest(ctx: FreshContext): Promise<Response> {
  const authErr = requireDashboardSession(ctx.req);
  if (authErr) return authErr;

  const config = getDashboardRequestConfig(ctx.req);
  const headers = new Headers();
  if (config.token) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }
  if (ctx.req.headers.get("content-type")) {
    headers.set("Content-Type", ctx.req.headers.get("content-type")!);
  }

  const body = ctx.req.method === "GET" ? undefined : await ctx.req.text();
  let response: Response;
  try {
    response = await fetch(`${config.brokerUrl}/api/agents`, {
      method: ctx.req.method,
      headers,
      body,
    });
  } catch {
    return Response.json({
      error: {
        code: "BROKER_UNREACHABLE",
        recovery: "Check the configured broker URL and network access.",
      },
    }, { status: 502 });
  }

  const responseHeaders = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) {
    responseHeaders.set("Content-Type", contentType);
  }

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

export default function ApiAgents() {
  return null;
}
