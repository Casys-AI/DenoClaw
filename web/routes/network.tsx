import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getAllInstancesData, type InstanceData } from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import { InstanceSelector } from "../components/InstanceSelector.tsx";
import { StatusDot } from "../components/StatusBadge.tsx";
import type { AgentStatusEntry, HealthResponse } from "../lib/types.ts";
import NetworkGraph from "../islands/NetworkGraph.tsx";

interface NetworkData {
  instances: InstanceData[];
  agents: AgentStatusEntry[];
  health: HealthResponse | null;
  selectedInstance: string;
  brokerUrl: string;
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

    const filteredInstances = selectedInstance === "all"
      ? instances
      : instances.filter((i) => i.instance.name === selectedInstance);

    const agents = filteredInstances.flatMap((i) => i.agents);
    const tunnels = filteredInstances.flatMap((i) => i.health?.tunnels ?? []);
    const mergedHealth: HealthResponse = {
      status: "ok",
      tunnels,
      tunnelCount: tunnels.length,
    };

    return page({
      instances,
      agents,
      health: mergedHealth,
      selectedInstance,
      brokerUrl: instances[0]?.instance.url ?? dashboard.brokerUrl,
    } as NetworkData);
  },
};

export default function Network({ data }: { data: NetworkData }) {
  const { instances, agents, health, selectedInstance, brokerUrl } = data;
  const tunnels = health?.tunnels ?? [];

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Network Topology</h1>

      <InstanceSelector
        instances={instances}
        selected={selectedInstance}
        basePath="/network"
      />

      <div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Graph — 3/4 */}
        <div class="lg:col-span-3 card bg-base-200">
          <div class="card-body p-4">
            <NetworkGraph
              agents={agents}
              tunnels={tunnels}
              brokerUrl={brokerUrl}
            />
          </div>
        </div>

        {/* Sidebar — 1/4 */}
        <div class="space-y-4">
          <div class="stats stats-vertical w-full bg-base-200">
            <div class="stat">
              <div class="stat-title">Agents</div>
              <div class="stat-value font-data text-lg">{agents.length}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Tunnels</div>
              <div class="stat-value font-data text-lg">{tunnels.length}</div>
            </div>
          </div>
          <div class="card bg-base-200">
            <div class="card-body p-4">
              <h3 class="text-xs font-display text-neutral-content uppercase tracking-wider">
                Agents
              </h3>
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
                      No agents found. Configure agents with{" "}
                      <code class="font-data">denoclaw agent create</code>.
                    </span>
                  </div>
                )
                : (
                  <ul class="space-y-2">
                    {agents.map((agent) => (
                      <li
                        key={agent.agentId}
                        class="flex items-center justify-between"
                      >
                        <a
                          href={`agents/${agent.agentId}`}
                          class="link link-primary text-sm"
                        >
                          {agent.agentId}
                        </a>
                        <StatusDot status={agent.status} />
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        </div>
      </div>

      <div class="text-xs font-data text-neutral-content">
        {agents.length} agents · {tunnels.length} tunnels
      </div>
    </div>
  );
}
