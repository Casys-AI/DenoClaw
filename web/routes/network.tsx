import { page } from "@fresh/core";
import { getAllInstancesData, type InstanceData } from "../lib/api-client.ts";
import { InstanceSelector } from "../components/InstanceSelector.tsx";
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

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <NetworkGraph agents={agents} tunnels={tunnels} brokerUrl={brokerUrl} />
        </div>
      </div>

      <div class="text-xs font-data text-neutral-content">
        {agents.length} agents · {tunnels.length} tunnels
      </div>
    </div>
  );
}
