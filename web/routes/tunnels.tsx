import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getFederationStats, getHealth } from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import type { FederationStatsSnapshot, HealthResponse } from "../lib/types.ts";
import { formatCompact, formatLatency, formatRelative } from "../lib/format.ts";

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

      {hasFederation && federation.links.length > 0 && (
        <div class="card bg-base-100 shadow">
          <div class="card-body p-4">
            <h2 class="card-title text-base font-display">Federation Links</h2>
            <div class="overflow-x-auto">
              <table class="table table-zebra">
                <thead>
                  <tr>
                    <th>Link</th>
                    <th>Remote</th>
                    <th>Success</th>
                    <th>Errors</th>
                    <th>P95</th>
                    <th>Latest Trace</th>
                    <th>Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {federation.links.map((link) => (
                    <tr key={link.linkId}>
                      <td class="font-mono text-xs">{link.linkId}</td>
                      <td class="font-mono text-xs">{link.remoteBrokerId}</td>
                      <td class="font-data text-success">
                        {formatCompact(link.successCount)}
                      </td>
                      <td class="font-data text-error">
                        {formatCompact(link.errorCount)}
                      </td>
                      <td class="font-data">{formatLatency(link.p95LatencyMs)}</td>
                      <td>
                        {link.lastTraceId
                          ? (
                            <div class="space-y-1">
                              <div
                                class="badge badge-outline badge-primary font-data"
                                title={link.lastTraceId}
                              >
                                {link.lastTraceId.slice(0, 8)}
                              </div>
                              {link.lastTaskId && (
                                <div
                                  class="text-[11px] font-mono text-neutral-content"
                                  title={link.lastTaskId}
                                >
                                  {link.lastTaskId}
                                </div>
                              )}
                            </div>
                          )
                          : <span class="text-xs text-neutral-content">none</span>}
                      </td>
                      <td class="text-xs text-neutral-content">
                        {link.lastOccurredAt
                          ? formatRelative(link.lastOccurredAt)
                          : "no events"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

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
