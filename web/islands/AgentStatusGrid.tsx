import { agentStatuses } from "./EventStream.tsx";

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    running: "badge-success",
    alive: "badge-info",
    stopped: "badge-error",
  };
  return <span class={`badge ${colorMap[status] ?? "badge-ghost"} badge-sm`}>{status}</span>;
}

/**
 * AgentStatusGrid — live agent cards driven by SSE signals.
 * Subscribes to agentStatuses signal from EventStream.
 */
export default function AgentStatusGrid() {
  const agents = agentStatuses.value;

  if (agents.length === 0) {
    return <div class="text-base-content/60 p-4">Waiting for agent data...</div>;
  }

  return (
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {agents.map((agent) => (
        <div key={agent.agentId} class="card bg-base-100 shadow-sm border border-base-300">
          <div class="card-body p-4">
            <div class="flex justify-between items-center">
              <a href={`/ui/agents/${agent.agentId}`} class="font-medium link link-primary">
                {agent.agentId}
              </a>
              <StatusBadge status={agent.status} />
            </div>
            {agent.model && (
              <div class="text-sm opacity-60">{agent.model}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
