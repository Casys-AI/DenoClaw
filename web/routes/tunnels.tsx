import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import {
  getFederationDeadLetters,
  getFederationStats,
  getHealth,
  replayFederationDeadLetter,
} from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import type {
  FederationDeadLetterEntry,
  FederationStatsSnapshot,
  HealthResponse,
} from "../lib/types.ts";
import { formatCompact, formatLatency, formatRelative } from "../lib/format.ts";

interface ReplayAlert {
  tone: "success" | "warning" | "error";
  message: string;
}

interface TunnelsData {
  health: HealthResponse | null;
  federation: FederationStatsSnapshot | null;
  deadLetters: FederationDeadLetterEntry[] | null;
  replayAlert: ReplayAlert | null;
}

function buildReplayAlert(status: string | null): ReplayAlert | null {
  switch (status) {
    case "forwarded":
      return {
        tone: "success",
        message: "Dead-letter replay forwarded successfully.",
      };
    case "deduplicated":
      return {
        tone: "success",
        message:
          "Dead-letter replay resolved as an already-settled submission.",
      };
    case "dead_letter":
      return {
        tone: "warning",
        message:
          "Dead-letter replay ran, but the submission returned to dead-letter.",
      };
    case "missing":
      return {
        tone: "warning",
        message: "Dead-letter entry no longer exists. Refresh completed.",
      };
    case "invalid":
      return {
        tone: "error",
        message: "Replay request was invalid.",
      };
    case "failed":
      return {
        tone: "error",
        message: "Dead-letter replay failed. Inspect broker logs and retry.",
      };
    default:
      return null;
  }
}

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const url = new URL(ctx.req.url);
    const [health, federation, deadLetters] = await Promise.all([
      getHealth({
        brokerUrl: dashboard.brokerUrl,
        token: dashboard.token,
      }),
      getFederationStats({
        brokerUrl: dashboard.brokerUrl,
        token: dashboard.token,
      }),
      getFederationDeadLetters({
        brokerUrl: dashboard.brokerUrl,
        token: dashboard.token,
      }),
    ]);
    return page({
      health,
      federation,
      deadLetters,
      replayAlert: buildReplayAlert(url.searchParams.get("replay")),
    } as TunnelsData);
  },

  async POST(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const form = await ctx.req.formData();
    const remoteBrokerId = typeof form.get("remoteBrokerId") === "string"
      ? form.get("remoteBrokerId")!.toString().trim()
      : "";
    const deadLetterId = typeof form.get("deadLetterId") === "string"
      ? form.get("deadLetterId")!.toString().trim()
      : "";
    const location = new URL(ctx.req.url);
    location.searchParams.delete("replay");

    if (!remoteBrokerId || !deadLetterId) {
      location.searchParams.set("replay", "invalid");
      return new Response(null, {
        status: 303,
        headers: { location: location.toString() },
      });
    }

    const replay = await replayFederationDeadLetter(
      { remoteBrokerId, deadLetterId },
      {
        brokerUrl: dashboard.brokerUrl,
        token: dashboard.token,
      },
    );
    const status = replay === null
      ? "failed"
      : replay.ok
      ? replay.result.status
      : replay.errorCode === "FEDERATION_DEAD_LETTER_NOT_FOUND"
      ? "missing"
      : "failed";
    location.searchParams.set("replay", status);
    return new Response(null, {
      status: 303,
      headers: { location: location.toString() },
    });
  },
};

export default function Tunnels({ data }: { data: TunnelsData }) {
  const tunnels = data.health?.tunnels ?? [];
  const federation = data.federation;
  const deadLetters = data.deadLetters;
  const hasFederation = federation !== null;
  const federationRefusalTotal = hasFederation
    ? federation.denials.policy + federation.denials.auth
    : 0;
  const federationRefusalText = hasFederation
    ? `${formatCompact(federation.denials.policy)} policy · ${
      formatCompact(federation.denials.auth)
    } auth${
      federation.denials.notFound > 0
        ? ` · ${formatCompact(federation.denials.notFound)} not found`
        : ""
    }`
    : "stats endpoint unavailable";

  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-bold">Tunnels</h1>

      {data.replayAlert && (
        <div
          role="alert"
          class={`alert ${
            data.replayAlert.tone === "success"
              ? "alert-success"
              : data.replayAlert.tone === "warning"
              ? "alert-warning"
              : "alert-error"
          }`}
        >
          <span>{data.replayAlert.message}</span>
        </div>
      )}

      <div class="stats stats-vertical lg:stats-horizontal bg-base-100 shadow">
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
              ? `${formatCompact(federation.errorCount)} delivery errors`
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
        <div class="stat">
          <div class="stat-title">Policy/Auth Refusals</div>
          <div
            class={`stat-value ${
              hasFederation ? "text-error" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(federationRefusalTotal)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {federationRefusalText}
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
                    <th>Policy</th>
                    <th>Auth</th>
                    <th>Not Found</th>
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
                      <td class="font-data text-warning">
                        {formatCompact(link.denials.policy)}
                      </td>
                      <td class="font-data text-error">
                        {formatCompact(link.denials.auth)}
                      </td>
                      <td class="font-data text-neutral-content">
                        {formatCompact(link.denials.notFound)}
                      </td>
                      <td class="font-data">
                        {formatLatency(link.p95LatencyMs)}
                      </td>
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
                          : (
                            <span class="text-xs text-neutral-content">
                              none
                            </span>
                          )}
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

      <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
          <h2 class="card-title text-base font-display">
            Dead Letters
          </h2>
          {deadLetters === null
            ? (
              <div class="text-sm text-warning">
                Dead-letter inspection endpoint unavailable.
              </div>
            )
            : deadLetters.length === 0
            ? (
              <div class="text-sm text-neutral-content">
                No federated dead-letter backlog.
              </div>
            )
            : (
              <div class="overflow-x-auto">
                <table class="table table-zebra">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Remote</th>
                      <th>Attempts</th>
                      <th>Reason</th>
                      <th>Moved</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {deadLetters.map((entry) => (
                      <tr key={entry.deadLetterId}>
                        <td>
                          <div class="space-y-1">
                            <div
                              class="font-mono text-xs"
                              title={entry.taskId}
                            >
                              {entry.taskId}
                            </div>
                            <div class="text-[11px] font-mono text-neutral-content">
                              {entry.task.targetAgent}
                            </div>
                            <div class="badge badge-outline badge-primary font-data">
                              {entry.traceId.slice(0, 8)}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div class="space-y-1">
                            <div class="font-mono text-xs">
                              {entry.remoteBrokerId}
                            </div>
                            <div class="text-[11px] font-mono text-neutral-content">
                              {entry.linkId}
                            </div>
                          </div>
                        </td>
                        <td class="font-data">
                          {formatCompact(entry.attempts)}
                        </td>
                        <td
                          class="max-w-md text-xs text-neutral-content"
                          title={entry.reason}
                        >
                          {entry.reason}
                        </td>
                        <td class="text-xs text-neutral-content">
                          {formatRelative(entry.movedAt)}
                        </td>
                        <td>
                          <form method="POST">
                            <input
                              type="hidden"
                              name="remoteBrokerId"
                              value={entry.remoteBrokerId}
                            />
                            <input
                              type="hidden"
                              name="deadLetterId"
                              value={entry.deadLetterId}
                            />
                            <button
                              class="btn btn-sm btn-primary"
                              type="submit"
                            >
                              Replay
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
