/**
 * OpenTelemetry instrumentation for DenoClaw.
 *
 * Deno 2.7 has built-in OTEL support — console.log, fetch(), Deno.serve()
 * are auto-instrumented. This module adds custom spans for:
 * - Agent loop iterations
 * - Tool executions
 * - LLM provider calls
 * - Message bus events
 *
 * Enable with: OTEL_DENO=1 deno run --unstable-otel ...
 * Or on Deno Deploy: automatic.
 */

import { log } from "../utils/log.ts";

// Use the npm OTEL API which Deno wires to its built-in implementation
let trace: typeof import("npm:@opentelemetry/api").trace | null = null;
let SpanStatusCode: typeof import("npm:@opentelemetry/api").SpanStatusCode | null = null;

async function loadOtel(): Promise<boolean> {
  try {
    const api = await import("@opentelemetry/api");
    trace = api.trace;
    SpanStatusCode = api.SpanStatusCode;
    log.info("OTEL: instrumentation activée");
    return true;
  } catch {
    log.debug("OTEL: @opentelemetry/api non disponible, instrumentation désactivée");
    return false;
  }
}

let initialized = false;

export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Only load if OTEL is enabled
  if (Deno.env.get("OTEL_DENO") || Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT")) {
    await loadOtel();
  } else {
    log.debug("OTEL: désactivé (set OTEL_DENO=1 pour activer)");
  }
}

function getTracer() {
  return trace?.getTracer("denoclaw", "0.1.0") ?? null;
}

/**
 * Wrap an async function in a named OTEL span.
 * Falls through transparently if OTEL is not loaded.
 */
export async function withSpan<T>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) return await fn();

  return await tracer.startActiveSpan(spanName, async (span) => {
    for (const [k, v] of Object.entries(attributes)) {
      span.setAttribute(k, v);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode!.OK });
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode!.ERROR, message: (e as Error).message });
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
    }
  });
}

// Pre-built span wrappers for common operations

export function spanAgentLoop<T>(sessionId: string, iteration: number, fn: () => Promise<T>): Promise<T> {
  return withSpan("agent.loop.iteration", {
    "agent.session_id": sessionId,
    "agent.iteration": iteration,
  }, fn);
}

export function spanToolCall<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  return withSpan("agent.tool.execute", {
    "tool.name": toolName,
  }, fn);
}

export function spanLLMCall<T>(model: string, provider: string, fn: () => Promise<T>): Promise<T> {
  return withSpan("llm.complete", {
    "llm.model": model,
    "llm.provider": provider,
  }, fn);
}

export function spanBusPublish<T>(channelType: string, messageId: string, fn: () => Promise<T>): Promise<T> {
  return withSpan("bus.publish", {
    "bus.channel_type": channelType,
    "bus.message_id": messageId,
  }, fn);
}
