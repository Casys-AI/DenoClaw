export type SpanType = "iteration" | "llm_call" | "tool_call" | "a2a_send";

export interface TraceCorrelationIds {
  taskId?: string;
  contextId?: string;
}

export interface TraceRoot extends TraceCorrelationIds {
  traceId: string;
  rootAgentId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed";
  totalIterations: number;
}

export interface Span extends TraceCorrelationIds {
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

export const DEFAULT_TRACE_TTL_MS = 24 * 60 * 60 * 1000;

export function resolveTraceCorrelationIds(
  sessionId: string,
  ids: TraceCorrelationIds = {},
): TraceCorrelationIds {
  const taskId = ids.taskId;
  const contextId = ids.contextId ?? taskId ?? sessionId;
  return {
    ...(taskId ? { taskId } : {}),
    ...(contextId ? { contextId } : {}),
  };
}
