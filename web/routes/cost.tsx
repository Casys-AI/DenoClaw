import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import {
  aggregateSummaries,
  getAllAgentMetrics,
  getAllInstancesData,
  type InstanceData,
} from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import { formatCompact, formatCost } from "../lib/format.ts";
import { InstanceSelector } from "../components/InstanceSelector.tsx";
import type { AgentMetrics, MetricsSummary } from "../lib/types.ts";

interface HourlyBucket {
  hour: string;
  provider: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

interface CostData {
  instances: InstanceData[];
  summary: MetricsSummary | null;
  agents: AgentMetrics[];
  hourly: HourlyBucket[];
  selectedInstance: string;
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
    });
    const filtered = selectedInstance === "all"
      ? instances
      : instances.filter((i) => i.instance.name === selectedInstance);
    const summary = aggregateSummaries(filtered);
    const agents: AgentMetrics[] = [];

    // Fetch metrics from filtered instances
    for (const inst of filtered) {
      if (!inst.reachable) continue;
      try {
        const metrics = await getAllAgentMetrics({
          brokerUrl: inst.instance.url,
          token: dashboard.token,
        });
        agents.push(...metrics);
      } catch { /* skip */ }
    }

    // Fetch hourly data for all agents
    const baseUrl = filtered[0]?.instance.url ?? dashboard.brokerUrl;
    const authHeaders: HeadersInit = dashboard.token
      ? { "Authorization": `Bearer ${dashboard.token}` }
      : {};
    const hourly: HourlyBucket[] = [];
    try {
      for (const agent of agents) {
        const res = await fetch(
          `${baseUrl}/stats/history?agent=${agent.agentId}`,
          { headers: authHeaders },
        );
        if (res.ok) {
          const data: HourlyBucket[] = await res.json();
          hourly.push(...data);
        }
      }
    } catch { /* gateway not available */ }

    return page(
      { instances, summary, agents, hourly, selectedInstance } as CostData,
    );
  },
};

export default function Cost({ data }: { data: CostData }) {
  const { instances, summary, agents, hourly, selectedInstance } = data;
  const totalCost = summary?.totalCostUsd ?? 0;
  const sortedByCost = [...agents].sort((a, b) =>
    b.llm.estimatedCostUsd - a.llm.estimatedCostUsd
  );
  const maxCost = sortedByCost[0]?.llm.estimatedCostUsd ?? 1;

  // Compute daily average from hourly buckets; fall back to null if no hourly data
  const hourlyTotalsForProjection = new Map<string, number>();
  for (const b of hourly) {
    hourlyTotalsForProjection.set(
      b.hour,
      (hourlyTotalsForProjection.get(b.hour) ?? 0) + b.costUsd,
    );
  }
  const uniqueDays = new Set(
    [...hourlyTotalsForProjection.keys()].map((h) => h.slice(0, 10)),
  );
  const projectedMonthly = uniqueDays.size > 0
    ? ([...hourlyTotalsForProjection.values()].reduce((s, c) => s + c, 0) /
      uniqueDays.size) * 30
    : null;

  // Aggregate hourly by provider
  const providerCosts = new Map<string, number>();
  for (const b of hourly) {
    providerCosts.set(
      b.provider,
      (providerCosts.get(b.provider) ?? 0) + b.costUsd,
    );
  }
  const providerList = [...providerCosts.entries()].sort((a, b) => b[1] - a[1]);
  const totalProviderCost = providerList.reduce((s, [, c]) => s + c, 0) ||
    totalCost;

  // Aggregate hourly by hour (for sparkline)
  const hourlyTotals = new Map<string, number>();
  for (const b of hourly) {
    hourlyTotals.set(b.hour, (hourlyTotals.get(b.hour) ?? 0) + b.costUsd);
  }
  const hourlyEntries = [...hourlyTotals.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const maxHourlyCost = Math.max(...hourlyEntries.map(([, c]) => c), 0.001);

  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-display font-bold">Cost Analytics</h1>
      <InstanceSelector
        instances={instances}
        selected={selectedInstance}
        basePath="/cost"
      />

      {/* KPIs */}
      <div class="stats stats-vertical sm:stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Today</div>
          <div class="stat-value text-warning font-data">
            {formatCost(totalCost)}
          </div>
          <div class="stat-desc">estimated</div>
        </div>
        <div class="stat">
          <div class="stat-title">Total Tokens</div>
          <div class="stat-value font-data">
            {formatCompact(summary?.totalTokens ?? 0)}
          </div>
          <div class="stat-desc">
            {formatCompact(summary?.totalLLMCalls ?? 0)} calls
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Projected Monthly</div>
          <div class="stat-value text-primary font-data">
            {projectedMonthly !== null ? formatCost(projectedMonthly) : "—"}
          </div>
          <div class="stat-desc">at current rate</div>
        </div>
        <div class="stat">
          <div class="stat-title">Providers</div>
          <div class="stat-value font-data">{providerList.length || "—"}</div>
          <div class="stat-desc">{agents.length} agents</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Cost trend + provider breakdown */}
        <div class="space-y-4">
          {/* Cost trend sparkline */}
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">Cost Trend</h2>
              {hourlyEntries.length === 0
                ? (
                  <div class="text-sm text-neutral-content">
                    No hourly data yet. Send messages to generate cost data.
                  </div>
                )
                : (
                  <div class="h-32">
                    <svg
                      viewBox={`0 0 ${hourlyEntries.length * 20} 100`}
                      class="w-full h-full"
                      preserveAspectRatio="none"
                    >
                      <defs>
                        <linearGradient
                          id="cost-grad"
                          x1="0%"
                          y1="0%"
                          x2="100%"
                          y2="0%"
                        >
                          <stop
                            offset="0%"
                            style="stop-color:#00C2FF;stop-opacity:0.3"
                          />
                          <stop
                            offset="100%"
                            style="stop-color:#0055FF;stop-opacity:0.3"
                          />
                        </linearGradient>
                      </defs>
                      {/* Area fill */}
                      <path
                        d={`M0,100 ${
                          hourlyEntries.map(([, c], i) =>
                            `L${i * 20},${100 - (c / maxHourlyCost) * 90}`
                          ).join(" ")
                        } L${(hourlyEntries.length - 1) * 20},100 Z`}
                        fill="url(#cost-grad)"
                      />
                      {/* Line */}
                      <polyline
                        points={hourlyEntries.map(([, c], i) =>
                          `${i * 20},${100 - (c / maxHourlyCost) * 90}`
                        ).join(" ")}
                        fill="none"
                        stroke="#00C2FF"
                        stroke-width="1.5"
                      />
                    </svg>
                    <div class="flex justify-between text-xs font-data text-neutral-content mt-1">
                      <span>{hourlyEntries[0]?.[0]?.slice(5) ?? ""}</span>
                      <span>
                        {hourlyEntries[hourlyEntries.length - 1]?.[0]?.slice(
                          5,
                        ) ?? ""}
                      </span>
                    </div>
                  </div>
                )}
            </div>
          </div>

          {/* Cost by provider */}
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">Cost by Provider</h2>
              {providerList.length === 0
                ? (
                  <div class="text-sm text-neutral-content">
                    No provider data yet.
                  </div>
                )
                : (
                  <div class="space-y-3">
                    {providerList.map(([provider, cost]) => {
                      const pct = totalProviderCost > 0
                        ? Math.round((cost / totalProviderCost) * 100)
                        : 0;
                      return (
                        <div key={provider} class="space-y-1">
                          <div class="flex justify-between text-sm">
                            <span class="font-data">{provider}</span>
                            <span class="font-data text-neutral-content">
                              {pct}% — {formatCost(cost)}
                            </span>
                          </div>
                          <progress
                            class="progress progress-primary w-full"
                            value={pct}
                            max="100"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>
          </div>
        </div>

        {/* Right: Agent ranking + Token efficiency */}
        <div class="space-y-4">
          {/* Agent cost ranking */}
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">Agent Cost Ranking</h2>
              <div class="space-y-3">
                {sortedByCost.map((agent) => {
                  const pct = maxCost > 0
                    ? (agent.llm.estimatedCostUsd / maxCost) * 100
                    : 0;
                  return (
                    <div key={agent.agentId} class="space-y-1">
                      <div class="flex justify-between text-sm">
                        <a
                          href={`agents/${agent.agentId}`}
                          class="link link-primary"
                        >
                          {agent.agentId}
                        </a>
                        <span class="font-data">
                          {formatCost(agent.llm.estimatedCostUsd)}
                        </span>
                      </div>
                      <progress
                        class="progress progress-primary w-full"
                        value={pct}
                        max="100"
                      />
                    </div>
                  );
                })}
                {agents.length === 0 && (
                  <div class="text-neutral-content text-sm">
                    No cost data yet.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Token efficiency */}
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">Token Efficiency</h2>
              {agents.length === 0
                ? <div class="text-neutral-content text-sm">No data yet.</div>
                : (
                  <div class="overflow-x-auto">
                    <table class="table table-sm">
                      <thead>
                        <tr class="text-neutral-content font-data text-xs uppercase">
                          <th>Agent</th>
                          <th class="text-right">Prompt</th>
                          <th class="text-right">Completion</th>
                          <th class="text-right">Ratio</th>
                          <th>Efficiency</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedByCost.map((agent) => {
                          const ratio = agent.llm.completionTokens > 0
                            ? (agent.llm.promptTokens /
                              agent.llm.completionTokens).toFixed(1)
                            : "—";
                          const ratioNum = parseFloat(ratio) || 0;
                          const eff = ratioNum > 5
                            ? { label: "Input-heavy", cls: "badge-warning" }
                            : ratioNum > 3
                            ? { label: "Heavy context", cls: "badge-warning" }
                            : { label: "Balanced", cls: "badge-success" };
                          return (
                            <tr key={agent.agentId}>
                              <td class="font-medium">{agent.agentId}</td>
                              <td class="text-right font-data">
                                {formatCompact(agent.llm.promptTokens)}
                              </td>
                              <td class="text-right font-data">
                                {formatCompact(agent.llm.completionTokens)}
                              </td>
                              <td class="text-right font-data">{ratio}:1</td>
                              <td>
                                <span class={`badge badge-sm ${eff.cls}`}>
                                  {eff.label}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </div>
        </div>
      </div>

      {/* Insight */}
      {sortedByCost.length > 0 && totalCost > 0 && (
        <div role="alert" class="alert bg-base-200">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            class="stroke-primary w-6 h-6 shrink-0"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>
            Agent{" "}
            <strong class="text-primary">{sortedByCost[0].agentId}</strong>{" "}
            accounts for{" "}
            <strong class="font-data">
              {Math.round(
                (sortedByCost[0].llm.estimatedCostUsd / totalCost) * 100,
              )}%
            </strong>{" "}
            of total cost. Projected monthly:{" "}
            <strong class="font-data text-warning">
              {projectedMonthly !== null ? formatCost(projectedMonthly) : "—"}
            </strong>.
          </span>
        </div>
      )}
    </div>
  );
}
