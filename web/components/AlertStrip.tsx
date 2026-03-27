import type { AgentMetrics, AgentStatusEntry } from "../lib/types.ts";

interface Alert {
  level: "error" | "warning";
  message: string;
  agent?: string;
}

interface AlertStripProps {
  agents: AgentStatusEntry[];
  metrics?: AgentMetrics[];
  totalCostUsd?: number;
}

/** Detect anomalies and render alert banners. */
export function AlertStrip({ agents, metrics, totalCostUsd }: AlertStripProps) {
  const alerts: Alert[] = [];

  // Stopped agents
  const stopped = agents.filter((a) => a.status === "stopped");
  for (const a of stopped) {
    alerts.push({
      level: "error",
      agent: a.agentId,
      message: `Agent "${a.agentId}" stopped unexpectedly`,
    });
  }

  // High tool failure rate (> 10%)
  if (metrics) {
    for (const m of metrics) {
      if (m.tools.calls > 10) {
        const failRate = m.tools.failures / m.tools.calls;
        if (failRate > 0.1) {
          alerts.push({
            level: "warning",
            agent: m.agentId,
            message: `Agent "${m.agentId}" tool failure rate: ${
              Math.round(failRate * 100)
            }%`,
          });
        }
      }
    }
  }

  // Cost spike warning (> $10 today)
  if (totalCostUsd && totalCostUsd > 10) {
    alerts.push({
      level: "warning",
      message: `Daily cost is $${
        totalCostUsd.toFixed(2)
      } — above $10 threshold`,
    });
  }

  if (alerts.length === 0) return null;

  return (
    <div class="space-y-2">
      {alerts.map((alert, i) => (
        <div
          key={i}
          role="alert"
          class={`alert ${
            alert.level === "error" ? "alert-error" : "alert-warning"
          }`}
        >
          <span class="text-sm">{alert.message}</span>
          {alert.agent && (
            <a href={`agents/${alert.agent}`} class="btn btn-ghost btn-xs">
              View →
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
