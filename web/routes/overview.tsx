import { page } from "@fresh/core";
import { getAllInstancesData, aggregateSummaries, type InstanceData } from "../lib/api-client.ts";
import { formatCompact, formatCost } from "../lib/format.ts";
import { StatusDot } from "../components/StatusBadge.tsx";
import { InstanceSelector } from "../components/InstanceSelector.tsx";
import { AlertStrip } from "../components/AlertStrip.tsx";
import type { MetricsSummary, AgentStatusEntry } from "../lib/types.ts";

interface OverviewData {
  instances: InstanceData[];
  summary: MetricsSummary;
  agents: AgentStatusEntry[];
  selectedInstance: string;
  tunnelCount: number;
}

export const handler = {
  async GET(req: Request) {
    const url = new URL(req.url);
    const selectedInstance = url.searchParams.get("instance") || "all";

    const instances = await getAllInstancesData();
    const summary = aggregateSummaries(
      selectedInstance === "all"
        ? instances
        : instances.filter((i) => i.instance.name === selectedInstance),
    );
    const agents = selectedInstance === "all"
      ? instances.flatMap((i) => i.agents)
      : instances.find((i) => i.instance.name === selectedInstance)?.agents ?? [];
    const tunnelCount = instances.reduce((s, i) => s + (i.health?.tunnelCount ?? 0), 0);

    return page({ instances, summary, agents, selectedInstance, tunnelCount } as OverviewData);
  },
};

export default function Overview({ data }: { data: OverviewData }) {
  const { instances, summary, agents, selectedInstance, tunnelCount } = data;
  const running = agents.filter((a) => a.status === "running" || a.status === "alive").length;

  return (
    <div class="space-y-6">
      {/* Instance Selector */}
      <InstanceSelector instances={instances} selected={selectedInstance} basePath="/overview" />

      {/* Alert system */}
      <AlertStrip agents={agents} totalCostUsd={summary.totalCostUsd} />

      {/* KPIs — DaisyUI stats */}
      <div class="stats stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Agents</div>
          <div class="stat-value text-primary font-data">{running}/{agents.length}</div>
          <div class="stat-desc">running / total</div>
        </div>
        <div class="stat">
          <div class="stat-title">LLM Calls</div>
          <div class="stat-value font-data">{formatCompact(summary.totalLLMCalls)}</div>
          <div class="stat-desc">{formatCompact(summary.totalTokens)} tokens</div>
        </div>
        <div class="stat">
          <div class="stat-title">Cost</div>
          <div class="stat-value text-warning font-data">{formatCost(summary.totalCostUsd)}</div>
          <div class="stat-desc">estimated</div>
        </div>
        <div class="stat">
          <div class="stat-title">Tool Calls</div>
          <div class="stat-value font-data">{formatCompact(summary.totalToolCalls)}</div>
        </div>
        <div class="stat">
          <div class="stat-title">A2A Messages</div>
          <div class="stat-value font-data">{formatCompact(summary.totalA2AMessages)}</div>
        </div>
        <div class="stat">
          <div class="stat-title">Instances</div>
          <div class="stat-value font-data">{instances.length}</div>
          <div class="stat-desc">{instances.filter((i) => i.reachable).length} online · {tunnelCount} tunnels</div>
        </div>
      </div>

      {/* Agent Grid + A2A Feed */}
      <div class="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div class="lg:col-span-3">
          <div class="card bg-base-200">
            <div class="card-body">
              <h2 class="card-title font-display">Agents</h2>
              {agents.length === 0 ? (
                <div class="text-neutral-content text-sm">No agents found.</div>
              ) : (
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {agents.map((agent) => (
                    <a key={`${agent.instance}-${agent.agentId}`} href={`/agents/${agent.agentId}`} class="card bg-base-100 hover:bg-neutral transition-colors">
                      <div class="card-body p-4 gap-2">
                        <div class="flex items-center justify-between">
                          <span class="font-medium">{agent.agentId}</span>
                          <div class="badge badge-sm gap-1">
                            <StatusDot status={agent.status} />
                            {agent.status}
                          </div>
                        </div>
                        {agent.instance && instances.length > 1 && (
                          <span class="text-xs font-data text-neutral-content">{agent.instance}</span>
                        )}
                        {agent.model && (
                          <span class="text-xs font-data text-neutral-content">{agent.model}</span>
                        )}
                        {agent.activeTask ? (
                          <span class="text-xs text-primary font-data truncate">
                            Processing: {agent.activeTask.taskId.slice(0, 12)}...
                          </span>
                        ) : (
                          <span class="text-xs text-neutral-content">Idle</span>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div class="lg:col-span-2">
          <div class="card bg-base-200 h-full">
            <div class="card-body">
              <h2 class="card-title font-display">Agent Communication</h2>
              <div class="text-sm text-neutral-content">
                A2A activity feed will appear here when agents communicate.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Unreachable instances warning */}
      {instances.some((i) => !i.reachable) && (
        <div role="alert" class="alert alert-warning">
          <span>
            Unreachable: {instances.filter((i) => !i.reachable).map((i) => i.instance.name).join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}
