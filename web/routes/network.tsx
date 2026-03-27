import { page } from "@fresh/core";
import { getAgents, getHealth, getBrokerUrl } from "../lib/api-client.ts";
import type { AgentStatusEntry, HealthResponse } from "../lib/types.ts";

interface NetworkData {
  agents: AgentStatusEntry[];
  health: HealthResponse | null;
  brokerUrl: string;
}

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    running: "bg-success",
    alive: "bg-info",
    stopped: "bg-error",
  };
  return <span class={`inline-block w-3 h-3 rounded-full ${color[status] ?? "bg-neutral"}`} />;
}

export const handler = {
  async GET(_req: Request) {
    const [agents, health] = await Promise.all([getAgents(), getHealth()]);
    return page({ agents, health, brokerUrl: getBrokerUrl() } as NetworkData);
  },
};

export default function Network({ data }: { data: NetworkData }) {
  const { agents, health } = data;
  const tunnels = health?.tunnels ?? [];

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Network Topology</h1>

      <div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Graph area — 3/4 */}
        <div class="lg:col-span-3">
          <div class="card bg-base-200 min-h-[500px]">
            <div class="card-body items-center justify-center">
              {/* SVG force-directed graph — will be an island */}
              <div class="relative w-full h-[460px] bg-base-300 flex items-center justify-center">
                {/* Static placeholder showing agent nodes */}
                <svg viewBox="0 0 600 400" class="w-full h-full">
                  {/* Broker center */}
                  <polygon points="300,160 330,180 330,210 300,230 270,210 270,180" fill="url(#grad)" stroke="none" />
                  <text x="300" y="250" text-anchor="middle" fill="#ababab" font-size="11" font-family="Inter">Broker</text>

                  {/* Agent nodes */}
                  {agents.map((agent, i) => {
                    const angle = (i / Math.max(agents.length, 1)) * Math.PI * 2 - Math.PI / 2;
                    const cx = 300 + Math.cos(angle) * 140;
                    const cy = 195 + Math.sin(angle) * 120;
                    const fill = agent.status === "running" ? "#22c55e"
                      : agent.status === "alive" ? "#3b82f6"
                      : "#ef4444";

                    return (
                      <g key={agent.agentId}>
                        <line x1="300" y1="195" x2={cx} y2={cy} stroke="#333" stroke-width="1" />
                        <circle cx={cx} cy={cy} r="18" fill={fill} opacity="0.8" />
                        <text x={cx} y={cy + 32} text-anchor="middle" fill="#e5e5e5" font-size="10" font-family="Inter">
                          {agent.agentId}
                        </text>
                      </g>
                    );
                  })}

                  {/* Tunnel nodes */}
                  {tunnels.map((id, i) => {
                    const cx = 80 + i * 60;
                    return (
                      <g key={id}>
                        <line x1="300" y1="195" x2={cx} y2="360" stroke="#00C2FF" stroke-width="1" stroke-dasharray="4" />
                        <rect x={cx - 12} y="348" width="24" height="24" fill="#1a1a1a" />
                        <text x={cx} y="390" text-anchor="middle" fill="#ababab" font-size="9" font-family="JetBrains Mono">
                          {id.slice(0, 8)}
                        </text>
                      </g>
                    );
                  })}

                  {/* Gradient def */}
                  <defs>
                    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style="stop-color:#00C2FF" />
                      <stop offset="100%" style="stop-color:#0055FF" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>

              {/* Legend */}
              <div class="flex gap-6 text-xs text-neutral-content mt-2">
                <div class="flex items-center gap-1"><span class="w-3 h-3 rounded-full bg-success" /> Agent</div>
                <div class="flex items-center gap-1"><span class="w-3 h-3 gradient-deno" style="clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)" /> Broker</div>
                <div class="flex items-center gap-1"><span class="w-3 h-3 bg-base-content/30" /> Tunnel</div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar — 1/4 */}
        <div class="space-y-4">
          {/* System health */}
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

          {/* Agent list */}
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

      {/* Bottom status */}
      <div class="text-xs font-data text-neutral-content">
        {agents.length} agents · {tunnels.length} tunnels · Network: {data.brokerUrl}
      </div>
    </div>
  );
}
