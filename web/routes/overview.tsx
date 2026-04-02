import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import {
  aggregateSummaries,
  getAllAgentMetrics,
  getAllInstancesData,
  type InstanceData,
} from "../lib/api-client.ts";
import {
  type FederationDenialTotals,
  selectLatestFederationLinkFromSnapshots,
  sumFederationDenialsAcrossSnapshots,
} from "../lib/federation.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import {
  formatCompact,
  formatCost,
  formatLatency,
  formatRelative,
} from "../lib/format.ts";
import { StatusDot } from "../components/StatusBadge.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { InstanceSelector } from "../components/InstanceSelector.tsx";
import { AlertStrip } from "../components/AlertStrip.tsx";
import AgentStatusGrid from "../islands/AgentStatusGrid.tsx";
import type {
  AgentMetrics,
  AgentStatusEntry,
  FederationLinkStats,
  MetricsSummary,
  TaskObservationEntry,
} from "../lib/types.ts";

interface OverviewData {
  instances: InstanceData[];
  summary: MetricsSummary;
  agents: AgentStatusEntry[];
  metrics: AgentMetrics[];
  tasks: TaskObservationEntry[];
  selectedInstance: string;
  tunnelCount: number;
  federationSuccess: number;
  federationErrors: number;
  federationDeadLetters: number;
  federationP95LatencyMs: number;
  federationDenials: FederationDenialTotals;
  federationReportingCount: number;
  federationExpectedCount: number;
  latestFederationLink: FederationLinkStats | null;
}

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const selectedInstance = ctx.url.searchParams.get("instance") || "all";
    const instances = await getAllInstancesData({
      instances: dashboard.instances,
      token: dashboard.token,
      includeFederation: true,
    });
    const filtered = selectedInstance === "all"
      ? instances
      : instances.filter((i) => i.instance.name === selectedInstance);
    const summary = aggregateSummaries(filtered);
    const agents = filtered.flatMap((i) => i.agents);
    const tunnelCount = instances.reduce(
      (s, i) => s + (i.health?.tunnelCount ?? 0),
      0,
    );
    const federationSuccess = filtered.reduce(
      (s, i) => s + (i.federation?.successCount ?? 0),
      0,
    );
    const federationErrors = filtered.reduce(
      (s, i) => s + (i.federation?.errorCount ?? 0),
      0,
    );
    const federationDeadLetters = filtered.reduce(
      (s, i) => s + (i.federation?.deadLetterBacklog ?? 0),
      0,
    );
    const federationDenials = sumFederationDenialsAcrossSnapshots(
      filtered.map((instance) => instance.federation),
    );
    const federationReportingCount = filtered.filter(
      (instance) => instance.federation !== null,
    ).length;
    const federationExpectedCount = filtered.length;
    const linkP95s = filtered
      .flatMap((i) => i.federation?.links ?? [])
      .map((link) => link.p95LatencyMs);
    const federationP95LatencyMs = linkP95s.length > 0
      ? Math.max(...linkP95s)
      : 0;
    const latestFederationLink = selectLatestFederationLinkFromSnapshots(
      filtered.map((instance) => instance.federation),
    );

    // Fetch per-agent metrics
    const metrics: AgentMetrics[] = [];
    for (const inst of filtered) {
      if (!inst.reachable) continue;
      try {
        const m = await getAllAgentMetrics({
          brokerUrl: inst.instance.url,
          token: dashboard.token,
        });
        metrics.push(...m);
      } catch {
        /* skip */
      }
    }

    // Fetch recent task observations
    let tasks: TaskObservationEntry[] = [];
    try {
      const brokerUrl = filtered[0]?.instance.url ?? dashboard.brokerUrl;
      const headers: HeadersInit = dashboard.token
        ? { Authorization: `Bearer ${dashboard.token}` }
        : {};
      const res = await fetch(`${brokerUrl}/tasks/observations`, { headers });
      if (res.ok) {
        const body = await res.json();
        tasks = Array.isArray(body) ? body.slice(0, 5) : [];
      }
    } catch {
      /* not available */
    }

    return page({
      instances,
      summary,
      agents,
      metrics,
      tasks,
      selectedInstance,
      tunnelCount,
      federationSuccess,
      federationErrors,
      federationDeadLetters,
      federationP95LatencyMs,
      federationDenials,
      federationReportingCount,
      federationExpectedCount,
      latestFederationLink,
    } as OverviewData);
  },
};

export default function Overview({ data }: { data: OverviewData }) {
  const {
    instances,
    summary,
    agents,
    metrics,
    tasks,
    selectedInstance,
    tunnelCount,
    federationSuccess,
    federationErrors,
    federationDeadLetters,
    federationP95LatencyMs,
    federationDenials,
    federationReportingCount,
    federationExpectedCount,
    latestFederationLink,
  } = data;
  const running = agents.filter(
    (a) => a.status === "running" || a.status === "alive",
  ).length;

  // Compute aggregate tool success rate
  const totalToolCalls = metrics.reduce((s, m) => s + m.tools.calls, 0);
  const totalToolSuccesses = metrics.reduce((s, m) => s + m.tools.successes, 0);
  const toolSuccessRate = totalToolCalls > 0
    ? Math.round((totalToolSuccesses / totalToolCalls) * 100)
    : 0;

  // Average LLM latency
  const avgLLMLatency = metrics.length > 0
    ? metrics.reduce((s, m) => s + m.llm.avgLatencyMs, 0) / metrics.length
    : 0;
  const hasFederation = federationReportingCount > 0;
  const federationCoverageText =
    federationReportingCount === federationExpectedCount
      ? `${formatCompact(federationErrors)} delivery errors`
      : `${
        formatCompact(federationErrors)
      } delivery errors · ${federationReportingCount}/${federationExpectedCount} brokers reporting`;
  const federationBacklogText =
    federationReportingCount === federationExpectedCount
      ? `dead-letter: ${formatCompact(federationDeadLetters)}`
      : `dead-letter: ${
        formatCompact(federationDeadLetters)
      } · partial coverage`;
  const federationRefusalTotal = federationDenials.policy +
    federationDenials.auth;
  const federationRefusalText = `${
    formatCompact(federationDenials.policy)
  } policy · ${formatCompact(federationDenials.auth)} auth${
    federationDenials.notFound > 0
      ? ` · ${formatCompact(federationDenials.notFound)} not found`
      : ""
  }`;

  return (
    <div class="space-y-4">
      {/* Instance Selector */}
      <InstanceSelector
        instances={instances}
        selected={selectedInstance}
        basePath="/overview"
      />

      {/* Alert system */}
      <AlertStrip
        agents={agents}
        metrics={metrics}
        totalCostUsd={summary.totalCostUsd}
      />

      {/* KPIs */}
      <div class="stats stats-vertical sm:stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Agents</div>
          <div class="stat-value text-primary font-data">
            {running}/{agents.length}
          </div>
          <div class="stat-desc">running / total</div>
        </div>
        <div class="stat">
          <div class="stat-title">LLM Calls</div>
          <div class="stat-value font-data">
            {formatCompact(summary.totalLLMCalls)}
          </div>
          <div class="stat-desc">
            {formatCompact(summary.totalTokens)} tokens
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Cost</div>
          <div class="stat-value text-warning font-data">
            {formatCost(summary.totalCostUsd)}
          </div>
          <div class="stat-desc">estimated</div>
        </div>
        <div class="stat">
          <div class="stat-title">Tool Calls</div>
          <div class="stat-value font-data">
            {formatCompact(summary.totalToolCalls)}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">A2A</div>
          <div class="stat-value font-data">
            {formatCompact(summary.totalA2AMessages)}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Instances</div>
          <div class="stat-value font-data">{instances.length}</div>
          <div class="stat-desc">
            {instances.filter((i) => i.reachable).length} online · {tunnelCount}
            {" "}
            tunnels
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Federation Success</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-success" : "text-warning text-base"
            }`}
          >
            {hasFederation ? formatCompact(federationSuccess) : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? federationCoverageText
              : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Worst Link P95</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatLatency(federationP95LatencyMs)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? federationBacklogText
              : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Policy/Auth Refusals</div>
          <div
            class={`stat-value font-data ${
              hasFederation ? "text-error" : "text-warning text-base"
            }`}
          >
            {hasFederation
              ? formatCompact(federationRefusalTotal)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {hasFederation
              ? federationRefusalText
              : "stats endpoint unavailable"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Latest Federation Trace</div>
          <div
            class={`stat-value font-data ${
              latestFederationLink?.lastTraceId
                ? "text-primary text-lg"
                : "text-warning text-base"
            }`}
          >
            {latestFederationLink?.lastTraceId
              ? latestFederationLink.lastTraceId.slice(0, 8)
              : "unavailable"}
          </div>
          <div class="stat-desc">
            {latestFederationLink?.lastOccurredAt
              ? `${latestFederationLink.lastTaskId ?? "task unknown"} · ${
                formatRelative(latestFederationLink.lastOccurredAt)
              }`
              : "no federation trace yet"}
          </div>
        </div>
      </div>

      {/* Main: Agent Grid + Recent A2A */}
      <div class="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Agent cards — 3/5 */}
        <div class="lg:col-span-3">
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">Agents</h2>
              {/* Live agent grid (updates via SSE) */}
              <AgentStatusGrid />
              {/* SSR fallback: detailed agent cards with metrics */}
              {agents.length === 0
                ? (
                  <div role="alert" class="alert alert-info">
                    <span>
                      No agents found. Configure agents with{" "}
                      <code class="font-data">denoclaw agent create</code>.
                    </span>
                  </div>
                )
                : (
                  <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {agents.map((agent) => {
                      const m = metrics.find((x) =>
                        x.agentId === agent.agentId
                      );
                      return (
                        <a
                          key={`${agent.instance}-${agent.agentId}`}
                          href={`agents/${agent.agentId}`}
                          class="card bg-base-100 hover:bg-neutral transition-colors"
                        >
                          <div class="card-body p-4 gap-1">
                            <div class="flex items-center justify-between">
                              <span class="font-medium">{agent.agentId}</span>
                              <div class="badge badge-sm gap-1">
                                <StatusDot status={agent.status} />
                                {agent.status}
                              </div>
                            </div>
                            {agent.model && (
                              <span class="text-xs font-data text-neutral-content">
                                {agent.model}
                              </span>
                            )}
                            {agent.activeTask
                              ? (
                                <span
                                  class="text-xs text-primary font-data truncate"
                                  title={agent.activeTask.taskId}
                                >
                                  Processing:{" "}
                                  {agent.activeTask.taskId.slice(0, 12)}
                                  ...
                                </span>
                              )
                              : (
                                <span class="text-xs text-neutral-content">
                                  Idle
                                </span>
                              )}
                            {/* Mini metrics */}
                            {m && m.llm.calls > 0 && (
                              <div class="flex gap-3 text-xs font-data text-neutral-content mt-1 border-t border-base-300 pt-1">
                                <span>{formatCompact(m.llm.calls)} LLM</span>
                                <span>
                                  {formatCost(m.llm.estimatedCostUsd)}
                                </span>
                                {m.tools.calls > 0 && (
                                  <span>
                                    {formatCompact(m.tools.calls)} tools
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </a>
                      );
                    })}
                  </div>
                )}
            </div>
          </div>
        </div>

        {/* Recent task observations — 2/5 */}
        <div class="lg:col-span-2">
          <div class="card bg-base-200 h-full">
            <div class="card-body">
              <div class="flex justify-between items-center">
                <h2 class="card-title font-display">Recent A2A</h2>
                <a href="a2a" class="btn btn-ghost btn-xs text-primary">
                  View all →
                </a>
              </div>
              {tasks.length === 0
                ? (
                  <div class="text-sm text-neutral-content">
                    No agent communication yet.
                    <a href="activity" class="link link-primary ml-1">
                      Open Activity Feed
                    </a>
                  </div>
                )
                : (
                  <div class="space-y-2">
                    {tasks.map((task) => (
                      <div
                        key={task.taskId}
                        class="flex items-center justify-between text-sm bg-base-100 p-2 rounded"
                      >
                        <div class="flex items-center gap-2">
                          <span class="font-medium">{task.from}</span>
                          <span class="text-neutral-content">→</span>
                          <span class="font-medium">{task.to}</span>
                        </div>
                        <StatusBadge status={task.status} size="xs" />
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom: 3 metric panels */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* LLM Performance */}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
              LLM Performance
            </h3>
            <div class="stat p-0">
              <div class="stat-value text-lg font-data">
                {formatCompact(summary.totalLLMCalls)}
              </div>
              <div class="stat-desc">calls total</div>
            </div>
            <div class="flex justify-between text-xs text-neutral-content mt-2">
              <span>Avg latency</span>
              <span class="font-data">{formatLatency(avgLLMLatency)}</span>
            </div>
            <div class="flex justify-between text-xs text-neutral-content">
              <span>Tokens</span>
              <span class="font-data">
                {formatCompact(summary.totalTokens)}
              </span>
            </div>
            <div class="flex justify-between text-xs text-neutral-content">
              <span>Cost</span>
              <span class="font-data text-warning">
                {formatCost(summary.totalCostUsd)}
              </span>
            </div>
          </div>
        </div>

        {/* Tool Utilization */}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
              Tool Utilization
            </h3>
            <div class="stat p-0">
              <div class="stat-value text-lg font-data">
                {totalToolCalls > 0 ? `${toolSuccessRate}%` : "—"}
              </div>
              <div class="stat-desc">success rate</div>
            </div>
            <div class="flex justify-between text-xs text-neutral-content mt-2">
              <span>Total calls</span>
              <span class="font-data">{formatCompact(totalToolCalls)}</span>
            </div>
            {totalToolCalls > 0 && (
              <progress
                class="progress progress-success w-full mt-1"
                value={toolSuccessRate}
                max="100"
              />
            )}
          </div>
        </div>

        {/* A2A Traffic */}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
              A2A Traffic
            </h3>
            <div class="stat p-0">
              <div class="stat-value text-lg font-data">
                {formatCompact(summary.totalA2AMessages)}
              </div>
              <div class="stat-desc">messages</div>
            </div>
            <div class="flex justify-between text-xs text-neutral-content mt-2">
              <span>Active tasks</span>
              <span class="font-data text-primary">
                {tasks.filter(
                  (t) => t.status === "sent" || t.status === "received",
                ).length}
              </span>
            </div>
            <div class="flex justify-between text-xs text-neutral-content">
              <span>Completed</span>
              <span class="font-data text-success">
                {tasks.filter((t) => t.status === "completed").length}
              </span>
            </div>
            <div class="flex justify-between text-xs text-neutral-content">
              <span>Failed</span>
              <span class="font-data text-error">
                {tasks.filter((t) => t.status === "failed").length}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Unreachable instances warning */}
      {instances.some((i) => !i.reachable) && (
        <div role="alert" class="alert alert-warning">
          <span>
            Unreachable: {instances
              .filter((i) =>
                !i.reachable
              )
              .map((i) => i.instance.name)
              .join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}
