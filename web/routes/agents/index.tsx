import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getAllInstancesData, getAllAgentMetrics, type InstanceData } from "../../lib/api-client.ts";
import { formatCompact, formatCost, formatLatency } from "../../lib/format.ts";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { InstanceSelector } from "../../components/InstanceSelector.tsx";
import type { AgentStatusEntry, AgentMetrics } from "../../lib/types.ts";


export const handler = {
  async GET(ctx: FreshContext) {
    const selectedInstance = ctx.url.searchParams.get("instance") || "all";
    const instances = await getAllInstancesData();

    const agents = selectedInstance === "all"
      ? instances.flatMap((i) => i.agents)
      : instances.find((i) => i.instance.name === selectedInstance)?.agents ?? [];

    // Fetch metrics for all agents (from all reachable instances)
    const allMetrics: AgentMetrics[] = [];
    for (const inst of instances) {
      if (!inst.reachable) continue;
      try {
        const metrics = await getAllAgentMetrics(inst.instance.url);
        allMetrics.push(...metrics);
      } catch { /* skip */ }
    }

    return page({ instances, agents, metrics: allMetrics, selectedInstance });
  },
};

export default function AgentsList({ data }: { data: { instances: InstanceData[]; agents: AgentStatusEntry[]; metrics: AgentMetrics[]; selectedInstance: string } }) {
  const { instances, agents, metrics, selectedInstance } = data;
  const metricsMap = new Map(metrics.map((m: AgentMetrics) => [m.agentId, m]));
  const multiInstance = instances.length > 1;

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Agents</h1>

      {/* Instance selector */}
      <InstanceSelector instances={instances} selected={selectedInstance} basePath="/agents" />

      {/* Summary */}
      <div class="text-sm text-neutral-content font-data">
        {agents.length} agents
        {" · "}{agents.filter((a) => a.status === "running").length} running
        {" · "}{agents.filter((a) => a.status === "alive").length} alive
        {" · "}{agents.filter((a) => a.status === "stopped").length} stopped
        {multiInstance && ` · ${instances.filter((i) => i.reachable).length} instances online`}
      </div>

      {agents.length === 0 ? (
        <div role="alert" class="alert">No agents found.</div>
      ) : (
        <div class="overflow-x-auto">
          <table class="table table-sm bg-base-200">
            <thead>
              <tr class="text-neutral-content font-data text-xs uppercase tracking-wider">
                <th>Agent</th>
                {multiInstance && <th>Instance</th>}
                <th>Status</th>
                <th>Model</th>
                <th class="text-right">LLM</th>
                <th class="text-right">Tokens</th>
                <th class="text-right">Cost</th>
                <th class="text-right">Tools</th>
                <th class="text-right">Fail%</th>
                <th class="text-right">Latency</th>
                <th class="text-right">A2A</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const m = metricsMap.get(agent.agentId);
                const failRate = m && m.tools.calls > 0
                  ? Math.round((m.tools.failures / m.tools.calls) * 100 * 10) / 10
                  : 0;

                return (
                  <tr key={`${agent.instance}-${agent.agentId}`} class="hover">
                    <td>
                      <a href={`/agents/${agent.agentId}`} class="link link-primary font-medium">
                        {agent.agentId}
                      </a>
                    </td>
                    {multiInstance && (
                      <td class="font-data text-xs text-neutral-content">{agent.instance ?? "—"}</td>
                    )}
                    <td><StatusBadge status={agent.status} /></td>
                    <td class="font-data text-xs text-neutral-content">{agent.model ?? "—"}</td>
                    <td class="text-right font-data">{formatCompact(m?.llm.calls ?? 0)}</td>
                    <td class="text-right font-data">{formatCompact(m?.llm.totalTokens ?? 0)}</td>
                    <td class="text-right font-data">{formatCost(m?.llm.estimatedCostUsd ?? 0)}</td>
                    <td class="text-right font-data">{formatCompact(m?.tools.calls ?? 0)}</td>
                    <td class={`text-right font-data ${failRate > 10 ? "text-error font-bold" : ""}`}>
                      {failRate}%
                    </td>
                    <td class="text-right font-data">{formatLatency(m?.llm.avgLatencyMs ?? 0)}</td>
                    <td class="text-right font-data">
                      {formatCompact((m?.a2a.messagesSent ?? 0) + (m?.a2a.messagesReceived ?? 0))}
                    </td>
                    <td>
                      {agent.activeTask ? (
                        <span class="text-xs font-data text-primary truncate max-w-32 inline-block">
                          {agent.activeTask.taskId.slice(0, 12)}...
                        </span>
                      ) : (
                        <span class="text-xs text-neutral-content">Idle</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
