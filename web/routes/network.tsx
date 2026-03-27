import { page } from "@fresh/core";
import { getAllInstancesData, type InstanceData } from "../lib/api-client.ts";
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
  async GET(req: Request) {
    const url = new URL(req.url);
    const selectedInstance = url.searchParams.get("instance") || "all";
    const instances = await getAllInstancesData();

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
      brokerUrl: instances[0]?.instance.url ?? "http://localhost:3000",
    } as NetworkData);
  },
};

export default function Network({ data }: { data: NetworkData }) {
  const { instances, agents, health, selectedInstance, brokerUrl } = data;
  const tunnels = health?.tunnels ?? [];

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Network Topology</h1>

      <InstanceSelector instances={instances} selected={selectedInstance} basePath="/network" />

      <div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Graph — 3/4 */}
        <div class="lg:col-span-3 card bg-base-200">
          <div class="card-body p-4">
            <NetworkGraph agents={agents} tunnels={tunnels} brokerUrl={brokerUrl} />
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
              <h3 class="font-display text-sm text-neutral-content">AGENTS</h3>
              <ul class="space-y-2">
                {agents.map((agent) => (
                  <li key={agent.agentId} class="flex items-center justify-between">
                    <a href={`/agents/${agent.agentId}`} class="link link-primary text-sm">{agent.agentId}</a>
                    <StatusDot status={agent.status} />
                  </li>
                ))}
              </ul>
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
