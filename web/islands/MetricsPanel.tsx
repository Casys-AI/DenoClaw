import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { formatCompact, formatCost } from "../lib/format.ts";
import type { MetricsSummary } from "../lib/types.ts";

const summary = signal<MetricsSummary | null>(null);

interface MetricsPanelProps {
  brokerUrl: string;
  initialData?: MetricsSummary | null;
}

/**
 * MetricsPanel — polls /stats every 10s for aggregate metrics.
 * Metrics don't need sub-second updates, polling is fine.
 */
export default function MetricsPanel({ brokerUrl, initialData }: MetricsPanelProps) {
  if (initialData && !summary.value) {
    summary.value = initialData;
  }

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch(`${brokerUrl}/stats`);
        if (res.ok) summary.value = await res.json();
      } catch {
        // ignore
      }
    }

    const interval = setInterval(poll, 10_000);
    poll();

    return () => clearInterval(interval);
  }, [brokerUrl]);

  const s = summary.value;

  return (
    <div class="stats stats-vertical lg:stats-horizontal w-full shadow bg-base-100">
      <div class="stat">
        <div class="stat-title">LLM Calls</div>
        <div class="stat-value text-primary">{formatCompact(s?.totalLLMCalls ?? 0)}</div>
        <div class="stat-desc">{formatCompact(s?.totalTokens ?? 0)} tokens</div>
      </div>
      <div class="stat">
        <div class="stat-title">Cost</div>
        <div class="stat-value text-warning">{formatCost(s?.totalCostUsd ?? 0)}</div>
        <div class="stat-desc">estimated</div>
      </div>
      <div class="stat">
        <div class="stat-title">Tool Calls</div>
        <div class="stat-value">{formatCompact(s?.totalToolCalls ?? 0)}</div>
      </div>
      <div class="stat">
        <div class="stat-title">A2A Messages</div>
        <div class="stat-value">{formatCompact(s?.totalA2AMessages ?? 0)}</div>
      </div>
    </div>
  );
}
