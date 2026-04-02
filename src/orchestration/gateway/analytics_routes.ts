import type { AnalyticsStore } from "../../db/analytics.ts";
import { getConfiguredAnalyticsStore } from "../../db/analytics.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

export interface GatewayAnalyticsRoutesContext {
  analytics?: AnalyticsStore | null;
}

export async function handleGatewayAnalyticsRoute(
  ctx: GatewayAnalyticsRoutesContext,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/stats/tools") {
    const analytics = resolveAnalyticsStore(ctx);
    if (analytics instanceof Response) return analytics;

    const agentId = url.searchParams.get("agent");
    if (!agentId) {
      return invalidInputResponse("Provide ?agent=<agentId> to query tool analytics");
    }

    try {
      const tools = await analytics.listToolStats({ agentId });
      return Response.json({ tools });
    } catch (error) {
      return analyticsQueryFailedResponse(url.pathname, error);
    }
  }

  if (url.pathname === "/stats/history") {
    const analytics = resolveAnalyticsStore(ctx);
    if (analytics instanceof Response) return analytics;

    const agentId = url.searchParams.get("agent");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    if (!agentId || !fromParam || !toParam) {
      return invalidInputResponse(
        "Provide ?agent=<agentId>&from=YYYY-MM-DD&to=YYYY-MM-DD",
      );
    }

    const from = parseIsoDate(fromParam);
    const to = parseIsoDate(toParam);
    if (!from || !to) {
      return invalidInputResponse("Use YYYY-MM-DD for from/to analytics dates");
    }

    try {
      const metrics = await analytics.listDailyMetrics({ agentId, from, to });
      return Response.json({ metrics });
    } catch (error) {
      return analyticsQueryFailedResponse(url.pathname, error);
    }
  }

  const tracesMatch = url.pathname.match(/^\/agents\/([^/]+)\/traces$/);
  if (tracesMatch) {
    const analytics = resolveAnalyticsStore(ctx);
    if (analytics instanceof Response) return analytics;

    const agentId = decodeURIComponent(tracesMatch[1]);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? 50 : parsePositiveInt(limitParam);
    if (limit === null || limit > 200) {
      return invalidInputResponse("Provide ?limit=<1-200> when querying historical traces");
    }

    try {
      const calls = await analytics.listLlmCalls({ agentId, limit });
      return Response.json({ calls });
    } catch (error) {
      return analyticsQueryFailedResponse(url.pathname, error);
    }
  }

  return null;
}

function resolveAnalyticsStore(
  ctx: GatewayAnalyticsRoutesContext,
): AnalyticsStore | Response {
  const analytics = resolveAnalyticsStoreConfig(ctx.analytics);
  if (analytics) return analytics;
  return analyticsNotConfiguredResponse();
}

function invalidInputResponse(recovery: string): Response {
  return Response.json({
    error: {
      code: "INVALID_INPUT",
      recovery,
    },
  }, { status: 400 });
}

function analyticsNotConfiguredResponse(): Response {
  return Response.json({
    error: {
      code: "ANALYTICS_NOT_CONFIGURED",
      recovery:
        "Set DATABASE_URL and run `deno task db:generate` to enable persistent analytics",
    },
  }, { status: 501 });
}

function analyticsQueryFailedResponse(
  pathname: string,
  error: unknown,
): Response {
  log.error("analytics: query failed", {
    pathname,
    error: error instanceof Error ? error.message : String(error),
  });

  const structuredError = error instanceof DenoClawError
    ? error.toStructured()
    : {
      code: "ANALYTICS_QUERY_FAILED",
      context: {
        message: error instanceof Error ? error.message : String(error),
      },
      recovery: "Retry the request or inspect the broker logs for the underlying datastore failure",
    };

  return Response.json({ error: structuredError }, { status: 503 });
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

function resolveAnalyticsStoreConfig(
  analytics: AnalyticsStore | null | undefined,
): AnalyticsStore | null {
  return analytics ?? getConfiguredAnalyticsStore();
}
