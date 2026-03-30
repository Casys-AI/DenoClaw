import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import ActivityFeed from "../islands/ActivityFeed.tsx";
import { getFederationStats } from "../lib/api-client.ts";
import {
  getFederationDenialTotals,
  selectLatestFederationLink,
} from "../lib/federation.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import { formatCompact, formatLatency, formatRelative } from "../lib/format.ts";
import type {
  FederationLinkStats,
  FederationStatsSnapshot,
} from "../lib/types.ts";

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const config = getDashboardRequestConfig(ctx.req);
    const federation = await getFederationStats({
      brokerUrl: config.brokerUrl,
      token: config.token,
    });
    const latestFederationLink = selectLatestFederationLink(federation);
    return page({ brokerUrl: config.brokerUrl, federation, latestFederationLink });
  },
};

export default function Activity({
  data,
}: {
  data: {
    brokerUrl: string;
    federation: FederationStatsSnapshot | null;
    latestFederationLink: FederationLinkStats | null;
  };
}) {
  const federation = data.federation;
  const hasFederation = federation !== null;
  const p95 = Math.max(
    0,
    ...(federation?.links.map((link) => link.p95LatencyMs) ?? []),
  );
  const federationDenials = getFederationDenialTotals(federation);
  const federationRefusalTotal =
    federationDenials.policy + federationDenials.auth;
  const federationRefusalText = `${formatCompact(federationDenials.policy)} policy · ${
    formatCompact(federationDenials.auth)
  } auth${
    federationDenials.notFound > 0
      ? ` · ${formatCompact(federationDenials.notFound)} not found`
      : ""
  }`;
  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Activity Feed</h1>
      <div class="stats stats-vertical lg:stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Federation Success</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-success text-lg" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(federation?.successCount ?? 0)
              : "unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Delivery Errors</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-error text-lg" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(federation?.errorCount ?? 0)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? "policy/auth surfaced separately"
              : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Worst Link P95</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-lg" : "text-base text-warning"
            }`}
          >
            {hasFederation ? formatLatency(p95) : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? `dead-letter: ${formatCompact(federation?.deadLetterBacklog ?? 0)}`
              : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Policy/Auth Refusals</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-error text-lg" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(federationRefusalTotal)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation ? federationRefusalText : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Latest Federation Trace</div>
          <div
            class={`stat-value font-data ${
              data.latestFederationLink?.lastTraceId
                ? "text-primary text-lg"
                : "text-warning text-base"
            }`}
          >
            {data.latestFederationLink?.lastTraceId
              ? data.latestFederationLink.lastTraceId.slice(0, 8)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {data.latestFederationLink?.lastOccurredAt
              ? `${data.latestFederationLink.lastTaskId ?? "task unknown"} · ${
                formatRelative(data.latestFederationLink.lastOccurredAt)
              }`
              : "no federation trace yet"}
          </div>
        </div>
      </div>
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <ActivityFeed />
        </div>
      </div>
      {Deno.env.get("DENO_DEPLOYMENT_ID")
        ? null
        : (
          <div class="text-xs font-data text-neutral-content">
            Streaming from: {data.brokerUrl} via /api/events proxy
          </div>
        )}
    </div>
  );
}
