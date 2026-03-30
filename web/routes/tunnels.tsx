import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getFederationStats, getHealth } from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import type { FederationStatsSnapshot, HealthResponse } from "../lib/types.ts";
import { formatCompact, formatLatency } from "../lib/format.ts";

interface TunnelsData {
  health: HealthResponse | null;
  federation: FederationStatsSnapshot | null;
}

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const health = await getHealth({
      brokerUrl: dashboard.brokerUrl,
      token: dashboard.token,
    });
    const federation = await getFederationStats({
      brokerUrl: dashboard.brokerUrl,
      token: dashboard.token,
    });
    return page({ health, federation } as TunnelsData);
  },
};

export default function Tunnels({ data }: { data: TunnelsData }) {
  const tunnels = data.health?.tunnels ?? [];
  const federation = data.federation;
  const hasFederation = federation !== null;

  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-bold">Tunnels</h1>

      <div class="stats bg-base-100 shadow">
        <div class="stat">
          <div class="stat-title">Connected</div>
          <div class="stat-value text-primary">
            {data.health?.tunnelCount ?? 0}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Federation Success</div>
          <div
            class={`stat-value ${
              hasFederation ? "text-success" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(federation.successCount)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? `${formatCompact(federation.errorCount)} errors`
              : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Worst Link P95</div>
          <div
            class={`stat-value ${
              hasFederation ? "" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatLatency(
                Math.max(0, ...federation.links.map((l) => l.p95LatencyMs)),
              )
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? `dead-letter: ${formatCompact(federation.deadLetterBacklog)}`
              : "stats endpoint unavailable"}
          </div>
        </div>
      </div>

      {tunnels.length === 0
        ? <div class="alert">No tunnels connected.</div>
        : (
          <div class="overflow-x-auto">
            <table class="table table-zebra bg-base-100 shadow rounded-box">
              <thead>
                <tr>
                  <th>Tunnel ID</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tunnels.map((id) => (
                  <tr key={id}>
                    <td class="font-mono text-sm">{id}</td>
                    <td>
                      <span class="badge badge-success badge-sm">
                        connected
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
