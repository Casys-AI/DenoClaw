import { useState } from "preact/hooks";

/** Span types from the trace system. */
interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  agentId: string;
  type: "iteration" | "llm_call" | "tool_call" | "a2a_send";
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  data: Record<string, unknown>;
}

interface FlameChartProps {
  spans: Span[];
  totalDurationMs: number;
  traceId?: string;
}

const TYPE_COLORS: Record<string, string> = {
  iteration: "#1a1a1a",
  llm_call: "url(#gradient-deno)",
  tool_call: "#555555",
  a2a_send: "#00C2FF",
};

const TYPE_LABELS: Record<string, string> = {
  iteration: "iter",
  llm_call: "LLM",
  tool_call: "tool",
  a2a_send: "A2A",
};

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function FlameChart({ spans, totalDurationMs, traceId }: FlameChartProps) {
  const [selected, setSelected] = useState<Span | null>(null);

  if (spans.length === 0) {
    return (
      <div class="bg-base-300 p-6 font-data text-sm text-neutral-content text-center">
        No trace data yet. Send a message to this agent to generate traces.
      </div>
    );
  }

  const width = 800;
  const rowHeight = 28;
  const padding = { top: 30, left: 60, right: 20 };
  const msToX = (ms: number) => padding.left + (ms / totalDurationMs) * (width - padding.left - padding.right);

  // Group spans by iteration
  const iterations = spans.filter((s) => s.type === "iteration");
  const childSpans = spans.filter((s) => s.type !== "iteration");

  // Calculate positions
  const rows: { span: Span; row: number; startMs: number; durationMs: number }[] = [];
  const traceStart = spans.length > 0
    ? Math.min(...spans.map((s) => new Date(s.startedAt).getTime()))
    : 0;

  iterations.forEach((iter, iterIdx) => {
    const iterStart = new Date(iter.startedAt).getTime() - traceStart;
    const iterDur = iter.latencyMs ?? 0;
    rows.push({ span: iter, row: iterIdx * 2, startMs: iterStart, durationMs: iterDur });

    // Children of this iteration
    const children = childSpans.filter((s) => s.parentSpanId === iter.spanId);
    children.forEach((child) => {
      const childStart = new Date(child.startedAt).getTime() - traceStart;
      const childDur = child.latencyMs ?? 0;
      rows.push({ span: child, row: iterIdx * 2 + 1, startMs: childStart, durationMs: childDur });
    });
  });

  const svgHeight = padding.top + (iterations.length * 2) * rowHeight + 20;

  return (
    <div class="space-y-3">
      <svg viewBox={`0 0 ${width} ${svgHeight}`} class="w-full" style={{ minHeight: `${svgHeight}px` }}>
        <defs>
          <linearGradient id="gradient-deno" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:#00C2FF" />
            <stop offset="100%" style="stop-color:#0055FF" />
          </linearGradient>
        </defs>

        {/* Time axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const x = msToX(pct * totalDurationMs);
          const ms = pct * totalDurationMs;
          return (
            <g key={pct}>
              <line x1={x} y1={padding.top - 15} x2={x} y2={svgHeight} stroke="#333" stroke-width="0.5" />
              <text x={x} y={padding.top - 18} text-anchor="middle" fill="#666" font-size="9" font-family="JetBrains Mono, monospace">
                {formatMs(ms)}
              </text>
            </g>
          );
        })}

        {/* Span bars */}
        {rows.map(({ span, row, startMs, durationMs }) => {
          const x = msToX(startMs);
          const w = Math.max(2, (durationMs / totalDurationMs) * (width - padding.left - padding.right));
          const y = padding.top + row * rowHeight;
          const isIteration = span.type === "iteration";
          const isSelected = selected?.spanId === span.spanId;
          const label = isIteration
            ? `iter ${(span.data as { iteration?: number }).iteration ?? "?"}`
            : `${TYPE_LABELS[span.type] ?? span.type}${span.data?.tool ? `:${span.data.tool}` : ""} ${formatMs(durationMs)}`;

          return (
            <g key={span.spanId} onClick={() => setSelected(span)} style={{ cursor: "pointer" }}>
              <rect
                x={x} y={y} width={w} height={isIteration ? rowHeight * 2 - 4 : rowHeight - 4}
                fill={TYPE_COLORS[span.type] ?? "#333"}
                opacity={isIteration ? 0.3 : 0.9}
                stroke={isSelected ? "#00C2FF" : "none"}
                stroke-width={isSelected ? 1.5 : 0}
                rx={0}
              />
              {w > 30 && (
                <text
                  x={x + 6} y={y + (isIteration ? rowHeight : rowHeight / 2) + 3}
                  fill={isIteration ? "#888" : "#e5e5e5"}
                  font-size={isIteration ? "10" : "9"}
                  font-family="JetBrains Mono, monospace"
                >
                  {label}
                </text>
              )}
              {/* Success/fail indicator for tool calls */}
              {span.type === "tool_call" && (
                <text
                  x={x + w + 4} y={y + rowHeight / 2 + 3}
                  fill={(span.data as { success?: boolean }).success ? "#22c55e" : "#ef4444"}
                  font-size="10"
                >
                  {(span.data as { success?: boolean }).success ? "✓" : "✗"}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Summary */}
      <div class="flex gap-4 text-xs font-data text-neutral-content">
        <span>{iterations.length} iterations</span>
        <span>·</span>
        <span>{childSpans.filter((s) => s.type === "llm_call").length} LLM calls</span>
        <span>·</span>
        <span>{childSpans.filter((s) => s.type === "tool_call").length} tool calls</span>
        <span>·</span>
        <span>Total: {formatMs(totalDurationMs)}</span>
        {traceId && (
          <>
            <span>·</span>
            <span class="text-primary">{traceId.slice(0, 12)}...</span>
          </>
        )}
      </div>

      {/* Selected span detail */}
      {selected && (
        <div class="bg-base-300 p-4 font-data text-xs space-y-1">
          <div class="flex justify-between">
            <span class="text-neutral-content">Type: <span class="text-base-content">{selected.type}</span></span>
            <button class="btn btn-ghost btn-xs" onClick={() => setSelected(null)}>✕</button>
          </div>
          <div class="text-neutral-content">Duration: <span class="text-base-content">{formatMs(selected.latencyMs ?? 0)}</span></div>
          <div class="text-neutral-content">Agent: <span class="text-base-content">{selected.agentId}</span></div>
          {selected.type === "llm_call" && (
            <>
              <div class="text-neutral-content">Model: <span class="text-base-content">{(selected.data as Record<string, unknown>).model as string}</span></div>
              <div class="text-neutral-content">
                Tokens: <span class="text-base-content">{(selected.data as Record<string, unknown>).promptTokens as number} in / {(selected.data as Record<string, unknown>).completionTokens as number} out</span>
              </div>
            </>
          )}
          {selected.type === "tool_call" && (
            <div class="text-neutral-content">Tool: <span class="text-base-content">{(selected.data as Record<string, unknown>).tool as string}</span></div>
          )}
          {selected.type === "a2a_send" && (
            <div class="text-neutral-content">To: <span class="text-primary">{(selected.data as Record<string, unknown>).toAgent as string}</span></div>
          )}
        </div>
      )}
    </div>
  );
}
