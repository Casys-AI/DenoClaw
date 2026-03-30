/**
 * Trace telemetry public surface.
 * Keeps legacy imports stable while the implementation lives in smaller modules.
 */

export type {
  Span,
  SpanData,
  SpanType,
  TraceCorrelationIds,
  TraceRoot,
} from "./trace_types.ts";
export {
  DEFAULT_TRACE_TTL_MS,
  resolveTraceCorrelationIds,
} from "./trace_types.ts";
export { TraceWriter } from "./trace_writer.ts";
export { getTrace, getTraceSpans, listAgentTraces } from "./trace_reader.ts";
