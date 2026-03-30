import { generateId } from "../shared/helpers.ts";
import {
  DEFAULT_TRACE_TTL_MS,
  resolveTraceCorrelationIds,
  type Span,
  type TraceCorrelationIds,
  type TraceRoot,
} from "./trace_types.ts";

export class TraceWriter {
  private readonly ttlMs: number;

  constructor(private readonly kv: Deno.Kv, ttlMs = DEFAULT_TRACE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async startTrace(
    agentId: string,
    sessionId: string,
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    const traceId = generateId();
    const root: TraceRoot = {
      traceId,
      rootAgentId: agentId,
      sessionId,
      ...resolveTraceCorrelationIds(sessionId, ids),
      startedAt: new Date().toISOString(),
      status: "running",
      totalIterations: 0,
    };
    await this.kv.set(["traces", traceId], root, { expireIn: this.ttlMs });
    return traceId;
  }

  async endTrace(
    traceId: string,
    status: "completed" | "failed",
    totalIterations: number,
  ): Promise<void> {
    const entry = await this.kv.get<TraceRoot>(["traces", traceId]);
    if (!entry.value) return;
    await this.kv.set(
      ["traces", traceId],
      {
        ...entry.value,
        endedAt: new Date().toISOString(),
        status,
        totalIterations,
      },
      { expireIn: this.ttlMs },
    );
  }

  async writeSpan(span: Omit<Span, "spanId">): Promise<string> {
    const spanId = generateId();
    await this.kv.set(
      ["traces", span.traceId, "span", spanId],
      { ...span, spanId },
      { expireIn: this.ttlMs },
    );
    return spanId;
  }

  async endSpan(
    traceId: string,
    spanId: string,
    latencyMs: number,
  ): Promise<void> {
    const entry = await this.kv.get<Span>(["traces", traceId, "span", spanId]);
    if (!entry.value) return;
    await this.kv.set(
      ["traces", traceId, "span", spanId],
      {
        ...entry.value,
        endedAt: new Date().toISOString(),
        latencyMs,
      },
      { expireIn: this.ttlMs },
    );
  }

  writeIterationSpan(
    traceId: string,
    agentId: string,
    iteration: number,
    parentSpanId?: string,
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      ...ids,
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
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      ...ids,
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
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      ...ids,
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
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    return this.writeSpan({
      traceId,
      parentSpanId,
      agentId,
      ...ids,
      type: "a2a_send",
      startedAt: new Date().toISOString(),
      data: { type: "a2a_send", toAgent, taskId },
    });
  }
}
