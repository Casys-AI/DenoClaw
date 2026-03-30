import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import ActivityFeed from "../islands/ActivityFeed.tsx";
import { getFederationStats } from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import { formatCompact, formatLatency } from "../lib/format.ts";
import type { FederationStatsSnapshot } from "../lib/types.ts";

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const config = getDashboardRequestConfig(ctx.req);
    const federation = await getFederationStats({
      brokerUrl: config.brokerUrl,
      token: config.token,
    });
    return page({ brokerUrl: config.brokerUrl, federation });
  },
};

export default function Activity({
  data,
}: {
  data: { brokerUrl: string; federation: FederationStatsSnapshot | null };
}) {
  const hasFederation = data.federation !== null;
  const p95 = Math.max(
    0,
    ...(data.federation?.links.map((link) => link.p95LatencyMs) ?? []),
  );
  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Activity Feed</h1>
      <div class="stats stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Federation Success</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-success text-lg" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(data.federation.successCount)
              : "unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Federation Errors</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-error text-lg" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(data.federation.errorCount)
              : "unavailable"}
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
              ? `dead-letter: ${
                formatCompact(data.federation.deadLetterBacklog)
              }`
              : "stats endpoint unavailable"}
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
