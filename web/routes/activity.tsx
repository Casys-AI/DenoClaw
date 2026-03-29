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

export default function Activity(
  { data }: { data: { brokerUrl: string; federation: FederationStatsSnapshot | null } },
) {
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
          <div class="stat-value text-success font-data text-lg">
            {formatCompact(data.federation?.successCount ?? 0)}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Federation Errors</div>
          <div class="stat-value text-error font-data text-lg">
            {formatCompact(data.federation?.errorCount ?? 0)}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Federation P95</div>
          <div class="stat-value font-data text-lg">{formatLatency(p95)}</div>
          <div class="stat-desc">
            dead-letter: {formatCompact(data.federation?.deadLetterBacklog ?? 0)}
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
