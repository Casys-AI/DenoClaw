import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import {
  getAgent,
  getAgentMetrics,
} from "../../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../../lib/dashboard-auth.ts";
import {
  formatCompact,
  formatCost,
  formatLatency,
  formatRelative,
} from "../../lib/format.ts";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import type { AgentMetrics, AgentStatusEntry } from "../../lib/types.ts";
import FlameChart from "../../islands/FlameChart.tsx";

interface TraceRoot {
  traceId: string;
  rootAgentId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  totalIterations: number;
}

interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  agentId: string;
  type: "iteration" | "llm_call" | "tool_call" | "a2a_send";
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  data: Record<string, unknown>;
}

interface ToolBreakdown {
  tool: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
}

interface AgentDetailData {
  agent: AgentStatusEntry | null;
  metrics: AgentMetrics | null;
  agentId: string;
  traces: TraceRoot[];
  latestSpans: Span[];
  latestTraceDuration: number;
  toolBreakdown: ToolBreakdown[];
}

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const agentId = ctx.params.id ?? "unknown";
    const brokerUrl = dashboard.brokerUrl;
    const headers: HeadersInit = dashboard.token
      ? { "Authorization": `Bearer ${dashboard.token}` }
      : {};

    const [agent, metrics] = await Promise.all([
      getAgent(agentId, { brokerUrl, token: dashboard.token }),
      getAgentMetrics(agentId, { brokerUrl, token: dashboard.token }),
    ]);

    // Fetch recent traces for this agent
    let traces: TraceRoot[] = [];
    let latestSpans: Span[] = [];
    let latestTraceDuration = 0;
    try {
      const res = await fetch(`${brokerUrl}/agents/${agentId}/traces?limit=5`, {
        headers,
      });
      if (res.ok) {
        const body = await res.json();
        traces = Array.isArray(body) ? body : [];
      }

      // Load spans for the most recent trace
      if (traces.length > 0) {
        const spanRes = await fetch(
          `${brokerUrl}/traces/${traces[0].traceId}/spans`,
          { headers },
        );
        if (spanRes.ok) latestSpans = await spanRes.json();
        const start = new Date(traces[0].startedAt).getTime();
        const end = traces[0].endedAt
          ? new Date(traces[0].endedAt).getTime()
          : Date.now();
        latestTraceDuration = end - start;
      }
    } catch { /* traces not available */ }

    // Fetch tool breakdown
    let toolBreakdown: ToolBreakdown[] = [];
    try {
      const res = await fetch(`${brokerUrl}/stats/tools?agent=${agentId}`, {
        headers,
      });
      if (res.ok) {
        const body = await res.json();
        toolBreakdown = Array.isArray(body) ? body : [];
      }
    } catch { /* not available */ }

    return page(
      {
        agent,
        metrics,
        agentId,
        traces,
        latestSpans,
        latestTraceDuration,
        toolBreakdown,
      } as AgentDetailData,
    );
  },
};

export default function AgentDetail({ data }: { data: AgentDetailData }) {
  const {
    agent,
    metrics,
    agentId,
    traces,
    latestSpans,
    latestTraceDuration,
    toolBreakdown,
  } = data;

  if (!agent && !metrics) {
    return (
      <div class="space-y-4">
        <a href="agents" class="btn btn-ghost btn-sm">&larr; Back</a>
        <div role="alert" class="alert alert-error">
          Agent "{agentId}" not found.
        </div>
      </div>
    );
  }

  return (
    <div class="space-y-6">
      {/* Header */}
      <div class="flex items-center gap-4">
        <a href="agents" class="btn btn-ghost btn-sm">&larr;</a>
        <div>
          <div class="text-xs text-neutral-content font-data">
            Agents / {agentId}
          </div>
          <div class="flex items-center gap-3">
            <h1 class="text-3xl font-display font-bold">{agentId}</h1>
            {agent && <StatusBadge status={agent.status} size="md" />}
          </div>
        </div>
        <div class="ml-auto text-right">
          {agent?.model && (
            <div class="font-data text-sm text-neutral-content">
              {agent.model}
            </div>
          )}
          {agent?.startedAt && (
            <div class="font-data text-xs text-neutral-content">
              Started {formatRelative(agent.startedAt)}
            </div>
          )}
          {agent?.activeTask && (
            <div class="font-data text-xs text-primary">
              Active:{" "}
              <span title={agent.activeTask.taskId}>
                {agent.activeTask.taskId.slice(0, 16)}...
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Metrics — DaisyUI stats */}
      {metrics && (
        <div class="stats stats-vertical lg:stats-horizontal w-full bg-base-200">
          <div class="stat">
            <div class="stat-title font-display text-xs">LLM PERFORMANCE</div>
            <div class="stat-value font-data text-2xl">
              {formatCompact(metrics.llm.calls)}
            </div>
            <div class="stat-desc">
              {formatCost(metrics.llm.estimatedCostUsd)} ·{" "}
              {formatLatency(metrics.llm.avgLatencyMs)} avg
            </div>
            <div class="stat-desc font-data text-xs">
              {formatCompact(metrics.llm.promptTokens)} prompt /{" "}
              {formatCompact(metrics.llm.completionTokens)} completion
            </div>
          </div>
          <div class="stat">
            <div class="stat-title font-display text-xs">TOOL UTILIZATION</div>
            <div class="stat-value font-data text-2xl">
              {formatCompact(metrics.tools.calls)}
            </div>
            <div class="stat-desc">
              {metrics.tools.calls > 0
                ? `${
                  Math.round(
                    (metrics.tools.successes / metrics.tools.calls) * 100,
                  )
                }% success`
                : "no calls"}
              {" · "}
              {formatLatency(metrics.tools.avgLatencyMs)} avg
            </div>
            {metrics.tools.failures > 0 && (
              <div class="stat-desc text-error font-data">
                {metrics.tools.failures} failures
              </div>
            )}
          </div>
          <div class="stat">
            <div class="stat-title font-display text-xs">A2A TRAFFIC</div>
            <div class="stat-value font-data text-2xl">
              {metrics.a2a.messagesSent + metrics.a2a.messagesReceived}
            </div>
            <div class="stat-desc">
              {metrics.a2a.messagesSent} sent · {metrics.a2a.messagesReceived}
              {" "}
              received
            </div>
            {metrics.a2a.peersContacted.length > 0 && (
              <div class="stat-desc">
                Peers:{" "}
                {metrics.a2a.peersContacted.map((p) => (
                  <span key={p} class="badge badge-sm badge-ghost mr-1">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Flame Chart — 2/3 */}
        <div class="lg:col-span-2">
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">
                Execution Trace
                {traces.length > 0 && (
                  <span class="badge badge-sm badge-primary font-data">
                    {traces[0].traceId.slice(0, 8)}
                  </span>
                )}
              </h2>
              <FlameChart
                spans={latestSpans}
                totalDurationMs={latestTraceDuration || 4100}
                traceId={traces[0]?.traceId}
              />
            </div>
          </div>
        </div>

        {/* Sidebar — 1/3 */}
        <div class="space-y-4">
          {/* Recent traces */}
          <div class="card bg-base-200">
            <div class="card-body p-4">
              <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
                Recent Traces
              </h3>
              {traces.length === 0
                ? <div class="text-xs text-neutral-content">No traces yet.</div>
                : (
                  <ul class="space-y-2">
                    {traces.map((t) => (
                      <li
                        key={t.traceId}
                        class="flex items-center justify-between text-xs"
                      >
                        <span class="font-data text-primary" title={t.traceId}>
                          {t.traceId.slice(0, 12)}...
                        </span>
                        <span
                          class={`badge badge-xs ${
                            t.status === "completed"
                              ? "badge-success"
                              : t.status === "failed"
                              ? "badge-error"
                              : "badge-info"
                          }`}
                        >
                          {t.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>

          {/* Peers */}
          {metrics && metrics.a2a.peersContacted.length > 0 && (
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
                  Connected Peers
                </h3>
                <ul class="space-y-1">
                  {metrics.a2a.peersContacted.map((peer) => (
                    <li key={peer}>
                      <a
                        href={`agents/${peer}`}
                        class="link link-primary text-sm"
                      >
                        {peer}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Tool breakdown */}
          {toolBreakdown.length > 0 && (
            <div class="card bg-base-200">
              <div class="card-body p-4">
                <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
                  Tool Breakdown
                </h3>
                <div class="space-y-2">
                  {toolBreakdown.map((t) => {
                    const failRate = t.calls > 0
                      ? Math.round((t.failures / t.calls) * 100)
                      : 0;
                    return (
                      <div
                        key={t.tool}
                        class="flex items-center justify-between text-xs"
                      >
                        <span class="font-data">{t.tool}</span>
                        <div class="flex items-center gap-2">
                          <span class="font-data">{t.calls} calls</span>
                          {failRate > 0 && (
                            <span class="text-error font-data">
                              {failRate}% fail
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
