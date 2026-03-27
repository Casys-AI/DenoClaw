import { page } from "@fresh/core";
import { getSummary, getAllAgentMetrics } from "../lib/api-client.ts";
import { formatCompact, formatCost } from "../lib/format.ts";
import type { MetricsSummary, AgentMetrics } from "../lib/types.ts";

interface CostData {
  summary: MetricsSummary | null;
  agents: AgentMetrics[];
}

export const handler = {
  async GET(_req: Request) {
    const [summary, agents] = await Promise.all([getSummary(), getAllAgentMetrics()]);
    return page({ summary, agents } as CostData);
  },
};

export default function Cost({ data }: { data: CostData }) {
  const { summary, agents } = data;
  const totalCost = summary?.totalCostUsd ?? 0;
  const sortedByCost = [...agents].sort((a, b) => b.llm.estimatedCostUsd - a.llm.estimatedCostUsd);
  const maxCost = sortedByCost[0]?.llm.estimatedCostUsd ?? 1;

  // Project monthly from today's cost (rough: assume 1 day of data)
  const projectedMonthly = totalCost * 30;

  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-display font-bold">Cost Analytics</h1>

      {/* KPIs — DaisyUI stats */}
      <div class="stats stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Today</div>
          <div class="stat-value font-data text-warning">{formatCost(totalCost)}</div>
          <div class="stat-desc">estimated</div>
        </div>
        <div class="stat">
          <div class="stat-title">Total Tokens</div>
          <div class="stat-value font-data">{formatCompact(summary?.totalTokens ?? 0)}</div>
          <div class="stat-desc">{formatCompact(summary?.totalLLMCalls ?? 0)} calls</div>
        </div>
        <div class="stat">
          <div class="stat-title">Projected Monthly</div>
          <div class="stat-value font-data text-primary">{formatCost(projectedMonthly)}</div>
          <div class="stat-desc">at current rate</div>
        </div>
        <div class="stat">
          <div class="stat-title">Agents</div>
          <div class="stat-value font-data">{agents.length}</div>
          <div class="stat-desc">with LLM activity</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Agent Cost Ranking */}
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title font-display text-sm">AGENT COST RANKING</h2>
            <div class="space-y-3">
              {sortedByCost.map((agent) => {
                const pct = maxCost > 0 ? (agent.llm.estimatedCostUsd / maxCost) * 100 : 0;
                return (
                  <div key={agent.agentId} class="space-y-1">
                    <div class="flex justify-between text-sm">
                      <a href={`/agents/${agent.agentId}`} class="link link-primary">{agent.agentId}</a>
                      <span class="font-data">{formatCost(agent.llm.estimatedCostUsd)}</span>
                    </div>
                    <progress class="progress progress-primary w-full" value={pct} max="100" />
                  </div>
                );
              })}
              {agents.length === 0 && (
                <div class="text-neutral-content text-sm">No cost data yet.</div>
              )}
            </div>
          </div>
        </div>

        {/* Token Efficiency */}
        <div class="card bg-base-200">
          <div class="card-body">
            <h2 class="card-title font-display text-sm">TOKEN EFFICIENCY</h2>
            {agents.length === 0 ? (
              <div class="text-neutral-content text-sm">No data yet.</div>
            ) : (
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
                        ? (agent.llm.promptTokens / agent.llm.completionTokens).toFixed(1)
                        : "—";
                      const ratioNum = parseFloat(ratio) || 0;
                      const efficiency = ratioNum > 5
                        ? { label: "Input-heavy", class: "badge-warning" }
                        : ratioNum > 3
                        ? { label: "Heavy context", class: "badge-warning" }
                        : { label: "Balanced", class: "badge-success" };

                      return (
                        <tr key={agent.agentId}>
                          <td class="font-medium">{agent.agentId}</td>
                          <td class="text-right font-data">{formatCompact(agent.llm.promptTokens)}</td>
                          <td class="text-right font-data">{formatCompact(agent.llm.completionTokens)}</td>
                          <td class="text-right font-data">{ratio}:1</td>
                          <td><span class={`badge badge-sm ${efficiency.class}`}>{efficiency.label}</span></td>
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

      {/* Insight */}
      {sortedByCost.length > 0 && totalCost > 0 && (
        <div role="alert" class="alert bg-base-200">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-primary w-6 h-6 shrink-0">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>
            Agent <strong class="text-primary">{sortedByCost[0].agentId}</strong> accounts for{" "}
            <strong class="font-data">
              {Math.round((sortedByCost[0].llm.estimatedCostUsd / totalCost) * 100)}%
            </strong>{" "}
            of total cost.
          </span>
        </div>
      )}
    </div>
  );
}
