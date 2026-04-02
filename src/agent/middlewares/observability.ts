import type { TraceCorrelationIds, TraceWriter } from "../../telemetry/traces.ts";
import { spanAgentLoop, spanToolCall } from "../../telemetry/mod.ts";
import type {
  LlmRequestEvent,
  LlmResponseEvent,
  ToolCallEvent,
} from "../events.ts";
import type { Middleware } from "../middleware.ts";

export interface ObservabilityDeps {
  traceWriter: TraceWriter | null;
  agentId: string;
  sessionId: string;
  correlationIds: TraceCorrelationIds;
}

export function observabilityMiddleware(deps: ObservabilityDeps): Middleware {
  const { traceWriter, agentId, sessionId, correlationIds } = deps;
  let traceId: string | undefined;
  let currentIteration = 0;
  let iterSpanId: string | undefined;
  let iterStart = 0;
  let llmStart = 0;
  let lastModel = "";

  return async (ctx, next) => {
    // Initialize trace on first event
    if (!traceId && traceWriter) {
      traceId = await traceWriter.startTrace(agentId, sessionId, correlationIds);
    }

    // New iteration — manage iteration spans
    if (ctx.event.iterationId > currentIteration) {
      if (iterSpanId && traceWriter && traceId) {
        await traceWriter.endSpan(traceId, iterSpanId, performance.now() - iterStart);
      }
      currentIteration = ctx.event.iterationId;
      iterStart = performance.now();
      if (traceWriter && traceId) {
        iterSpanId = await traceWriter.writeIterationSpan(
          traceId, agentId, currentIteration, undefined, correlationIds,
        );
      }
    }

    // LLM request — wrap in OTEL span, capture model, record timing
    if (ctx.event.type === "llm_request") {
      llmStart = performance.now();
      lastModel = (ctx.event as LlmRequestEvent).config.model;
      return spanAgentLoop(sessionId, currentIteration, async () => {
        return await next();
      });
    }

    // LLM response — write trace span using captured model
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      if (traceWriter && traceId && iterSpanId) {
        const provider = lastModel.includes("/") ? lastModel.split("/")[0] : lastModel;
        await traceWriter.writeLLMSpan(
          traceId, agentId, iterSpanId, lastModel, provider,
          { prompt: e.usage?.promptTokens ?? 0, completion: e.usage?.completionTokens ?? 0 },
          performance.now() - llmStart, correlationIds,
        );
      }
      return next();
    }

    // Tool call — wrap in OTEL span, write trace span after execution
    if (ctx.event.type === "tool_call") {
      const toolStart = performance.now();
      const e = ctx.event as ToolCallEvent;
      return spanToolCall(e.name, async () => {
        const resolution = await next();
        if (traceWriter && traceId && iterSpanId && resolution?.type === "tool") {
          await traceWriter.writeToolSpan(
            traceId, agentId, iterSpanId, e.name,
            resolution.result.success, performance.now() - toolStart,
            e.arguments, correlationIds,
          );
        }
        return resolution;
      });
    }

    // Complete/error — end iteration span + trace
    if (ctx.event.type === "complete" || ctx.event.type === "error") {
      if (iterSpanId && traceWriter && traceId) {
        await traceWriter.endSpan(traceId, iterSpanId, performance.now() - iterStart);
      }
      if (traceWriter && traceId) {
        await traceWriter.endTrace(
          traceId,
          ctx.event.type === "complete" ? "completed" : "failed",
          currentIteration,
        ).catch(() => {});
      }
      return next();
    }

    return next();
  };
}
