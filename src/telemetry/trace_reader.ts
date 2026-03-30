import type { Span, TraceRoot } from "./trace_types.ts";

export async function getTrace(
  kv: Deno.Kv,
  traceId: string,
): Promise<TraceRoot | null> {
  const entry = await kv.get<TraceRoot>(["traces", traceId]);
  return entry.value;
}

export async function getTraceSpans(
  kv: Deno.Kv,
  traceId: string,
): Promise<Span[]> {
  const spans: Span[] = [];
  for await (
    const entry of kv.list<Span>({ prefix: ["traces", traceId, "span"] })
  ) {
    if (entry.value) spans.push(entry.value);
  }
  return spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function listAgentTraces(
  kv: Deno.Kv,
  agentId: string,
  limit = 20,
): Promise<TraceRoot[]> {
  const traces: TraceRoot[] = [];
  for await (const entry of kv.list<TraceRoot>({ prefix: ["traces"] })) {
    if (entry.key.length === 2 && entry.value?.rootAgentId === agentId) {
      traces.push(entry.value);
    }
  }
  return traces
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}
