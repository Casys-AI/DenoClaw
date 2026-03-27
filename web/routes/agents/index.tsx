import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import {
  getAllAgentMetrics,
  getAllInstancesData,
  type InstanceData,
} from "../../lib/api-client.ts";
import { formatCompact, formatCost, formatLatency } from "../../lib/format.ts";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { InstanceSelector } from "../../components/InstanceSelector.tsx";
import type { AgentMetrics, AgentStatusEntry } from "../../lib/types.ts";
import {
  default as CreateAgentModal,
} from "../../islands/CreateAgentModal.tsx";
import { getBrokerUrl } from "../../lib/api-client.ts";

export const handler = {
  async GET(ctx: FreshContext) {
    const selectedInstance = ctx.url.searchParams.get("instance") || "all";
    const instances = await getAllInstancesData();

    const agents = selectedInstance === "all"
      ? instances.flatMap((i) => i.agents)
      : instances.find((i) => i.instance.name === selectedInstance)?.agents ??
        [];

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

export default function AgentsList(
  { data }: {
    data: {
      instances: InstanceData[];
      agents: AgentStatusEntry[];
      metrics: AgentMetrics[];
      selectedInstance: string;
    };
  },
) {
  const { instances, agents, metrics, selectedInstance } = data;
  const metricsMap = new Map(metrics.map((m: AgentMetrics) => [m.agentId, m]));
  const multiInstance = instances.length > 1;

  return (
    <div class="space-y-4">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-display font-bold">Agents</h1>
        <CreateAgentModal brokerUrl={getBrokerUrl()} />
      </div>

      {/* Instance selector */}
      <InstanceSelector
        instances={instances}
        selected={selectedInstance}
        basePath="/agents"
      />

      {/* Summary */}
      <div class="text-sm text-neutral-content font-data">
        {agents.length} agents
        {" · "}
        {agents.filter((a) => a.status === "running").length} running
        {" · "}
        {agents.filter((a) => a.status === "alive").length} alive
        {" · "}
        {agents.filter((a) => a.status === "stopped").length} stopped
        {multiInstance &&
          ` · ${instances.filter((i) => i.reachable).length} instances online`}
      </div>

      {agents.length === 0
        ? (
          <div role="alert" class="alert alert-info">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              class="stroke-current w-6 h-6 shrink-0"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>
              No agents found. Click "+ New Agent" to create one.
            </span>
          </div>
        )
        : (
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
                    ? Math.round(
                      (m.tools.failures / m.tools.calls) * 100 * 10,
                    ) / 10
                    : 0;

                  return (
                    <tr
                      key={`${agent.instance}-${agent.agentId}`}
                      class="hover"
                    >
                      <td>
                        <a
                          href={`agents/${agent.agentId}`}
                          class="link link-primary font-medium"
                        >
                          {agent.agentId}
                        </a>
                      </td>
                      {multiInstance && (
                        <td class="font-data text-xs text-neutral-content">
                          {agent.instance ?? "—"}
                        </td>
                      )}
                      <td>
                        <StatusBadge status={agent.status} />
                      </td>
                      <td class="font-data text-xs text-neutral-content">
                        {agent.model ?? "—"}
                      </td>
                      <td class="text-right font-data">
                        {formatCompact(m?.llm.calls ?? 0)}
                      </td>
                      <td class="text-right font-data">
                        {formatCompact(m?.llm.totalTokens ?? 0)}
                      </td>
                      <td class="text-right font-data">
                        {formatCost(m?.llm.estimatedCostUsd ?? 0)}
                      </td>
                      <td class="text-right font-data">
                        {formatCompact(m?.tools.calls ?? 0)}
                      </td>
                      <td
                        class={`text-right font-data ${
                          failRate > 10 ? "text-error font-bold" : ""
                        }`}
                      >
                        {failRate}%
                      </td>
                      <td class="text-right font-data">
                        {formatLatency(m?.llm.avgLatencyMs ?? 0)}
                      </td>
                      <td class="text-right font-data">
                        {formatCompact(
                          (m?.a2a.messagesSent ?? 0) +
                            (m?.a2a.messagesReceived ?? 0),
                        )}
                      </td>
                      <td>
                        {agent.activeTask
                          ? (
                            <span
                              class="text-xs font-data text-primary truncate max-w-32 inline-block"
                              title={agent.activeTask.taskId}
                            >
                              {agent.activeTask.taskId.slice(0, 12)}...
                            </span>
                          )
                          : (
                            <span class="text-xs text-neutral-content">
                              Idle
                            </span>
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
