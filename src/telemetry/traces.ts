/**
 * Trace writer — writes per-iteration ReAct trace spans to shared KV.
 * Enables the dashboard flame chart view (ADR-007).
 *
 * KV schema:
 *   ["traces", traceId]                        → TraceRoot
 *   ["traces", traceId, "span", spanId]        → Span
 *
 * Traces have a 24h TTL by default (configurable).
 */

import { generateId } from "../shared/helpers.ts";

// ── Types ──────────────────────────────────────────────

export type SpanType = "iteration" | "llm_call" | "tool_call" | "a2a_send";

export interface TraceRoot {
  traceId: string;
  rootAgentId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed";
  totalIterations: number;
}

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  agentId: string;
  type: SpanType;
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  data: SpanData;
}

export type SpanData =
  | { type: "iteration"; iteration: number }
  | {
    type: "llm_call";
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
  }
  | {
    type: "tool_call";
    tool: string;
    success: boolean;
    args?: Record<string, unknown>;
  }
  | { type: "a2a_send"; toAgent: string; taskId: string };

// ── TTL ────────────────────────────────────────────────

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ── Writer ─────────────────────────────────────────────

export class TraceWriter {
  private kv: Deno.Kv;
  private ttlMs: number;

  constructor(kv: Deno.Kv, ttlMs = DEFAULT_TTL_MS) {
    this.kv = kv;
    this.ttlMs = ttlMs;
  }

  /** Start a new trace. Returns the traceId. */
  async startTrace(agentId: string, sessionId: string): Promise<string> {
    const traceId = generateId();
    const root: TraceRoot = {
      traceId,
      rootAgentId: agentId,
      sessionId,
      startedAt: new Date().toISOString(),
      status: "running",
      totalIterations: 0,
    };
    await this.kv.set(["traces", traceId], root, { expireIn: this.ttlMs });
    return traceId;
  }

  /** End a trace with final status. */
  async endTrace(
    traceId: string,
    status: "completed" | "failed",
    totalIterations: number,
  ): Promise<void> {
    const entry = await this.kv.get<TraceRoot>(["traces", traceId]);
    if (!entry.value) return;
    const updated: TraceRoot = {
      ...entry.value,
      endedAt: new Date().toISOString(),
      status,
      totalIterations,
    };
    await this.kv.set(["traces", traceId], updated, { expireIn: this.ttlMs });
  }

  /** Write a span. Returns the spanId. */
  async writeSpan(span: Omit<Span, "spanId">): Promise<string> {
    const spanId = generateId();
    const full: Span = { ...span, spanId };
    await this.kv.set(
      ["traces", span.traceId, "span", spanId],
      full,
      { expireIn: this.ttlMs },
    );
    return spanId;
  }

  /** End a span (update with endedAt + latencyMs). */
  async endSpan(
    traceId: string,
    spanId: string,
    latencyMs: number,
  ): Promise<void> {
    const entry = await this.kv.get<Span>(["traces", traceId, "span", spanId]);
    if (!entry.value) return;
    const updated: Span = {
      ...entry.value,
      endedAt: new Date().toISOString(),
      latencyMs,
    };
    await this.kv.set(
      ["traces", traceId, "span", spanId],
      updated,
      { expireIn: this.ttlMs },
    );
  }

  // ── Convenience methods ────────────────────────────────

  writeIterationSpan(
    traceId: string,
    agentId: string,
    iteration: number,
    parentSpanId?: string,
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      type: "iteration",
      startedAt: new Date().toISOString(),
      data: { type: "iteration", iteration },
    });
  }

  writeLLMSpan(
    traceId: string,
    agentId: string,
    parentSpanId: string,
    model: string,
    provider: string,
    tokens: { prompt: number; completion: number },
    latencyMs: number,
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      type: "llm_call",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      latencyMs,
      data: {
        type: "llm_call",
        model,
        provider,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
      },
    });
  }

  writeToolSpan(
    traceId: string,
    agentId: string,
    parentSpanId: string,
    tool: string,
    success: boolean,
    latencyMs: number,
    args?: Record<string, unknown>,
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      type: "tool_call",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      latencyMs,
      data: { type: "tool_call", tool, success, args },
    });
  }

  writeA2ASendSpan(
    traceId: string,
    agentId: string,
    parentSpanId: string,
    toAgent: string,
    taskId: string,
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      type: "a2a_send",
      startedAt: new Date().toISOString(),
      data: { type: "a2a_send", toAgent, taskId },
    });
  }
}

// ── Reader ─────────────────────────────────────────────

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

/** List recent traces for an agent. */
export async function listAgentTraces(
  kv: Deno.Kv,
  agentId: string,
  limit = 20,
): Promise<TraceRoot[]> {
  const traces: TraceRoot[] = [];
  for await (const entry of kv.list<TraceRoot>({ prefix: ["traces"] })) {
    // Only match root entries ["traces", traceId] (length 2)
    if (entry.key.length === 2 && entry.value?.rootAgentId === agentId) {
      traces.push(entry.value);
    }
  }
  return traces
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}
