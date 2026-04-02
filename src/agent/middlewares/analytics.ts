import type { AnalyticsStore } from "../../db/analytics.ts";
import type { AnalyticsWriteScheduler } from "../../db/analytics_async.ts";
import { scheduleAnalyticsWrite } from "../../db/analytics_async.ts";
import { formatToolResultContent } from "../events.ts";
import type {
  LlmRequestEvent,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../events.ts";
import type { Middleware } from "../middleware.ts";

export interface AnalyticsMiddlewareDeps {
  analytics: AnalyticsStore;
  now?: () => number;
  writeScheduler?: AnalyticsWriteScheduler;
}

export function analyticsMiddleware(deps: AnalyticsMiddlewareDeps): Middleware {
  const now = deps.now ?? (() => performance.now());
  const writeScheduler = deps.writeScheduler;
  let lastModel = "";
  let lastLlmLatencyMs = 0;
  const toolDurationsMs = new Map<string, number>();

  const scheduleWrite = (operation: string, write: () => Promise<void>) => {
    if (writeScheduler) {
      writeScheduler.schedule(operation, write);
      return;
    }
    scheduleAnalyticsWrite(operation, write);
  };

  return async (ctx, next) => {
    if (ctx.event.type === "llm_request") {
      const request = ctx.event as LlmRequestEvent;
      const startedAt = now();
      lastModel = request.config.model;
      const resolution = await next();
      lastLlmLatencyMs = Math.max(0, Math.round(now() - startedAt));
      return resolution;
    }

    if (ctx.event.type === "tool_call") {
      const event = ctx.event as ToolCallEvent;
      const startedAt = now();
      const resolution = await next();
      toolDurationsMs.set(
        event.callId,
        Math.max(0, Math.round(now() - startedAt)),
      );
      return resolution;
    }

    const resolution = await next();
    const taskId = ctx.session.taskId;

    if (ctx.event.type === "llm_response") {
      const event = ctx.event as LlmResponseEvent;
      const createdAt = new Date(event.timestamp);
      const model = lastModel || "unknown";
      const provider = model.includes("/") ? model.split("/")[0] : "unknown";

      scheduleWrite("record LLM call", () => deps.analytics.recordLlmCall({
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId,
        taskId,
        model,
        provider,
        promptTokens: event.usage?.promptTokens ?? 0,
        completionTokens: event.usage?.completionTokens ?? 0,
        latencyMs: lastLlmLatencyMs,
        createdAt,
      }));

      scheduleWrite("record conversation", () => deps.analytics.recordConversation({
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId,
        taskId,
        role: "assistant",
        content: event.content,
        createdAt,
      }));
    }

    if (ctx.event.type === "tool_result") {
      const event = ctx.event as ToolResultEvent;
      const createdAt = new Date(event.timestamp);
      const durationMs = toolDurationsMs.get(event.callId) ?? 0;
      toolDurationsMs.delete(event.callId);

      scheduleWrite("record tool execution", () => deps.analytics.recordToolExecution({
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId,
        taskId,
        toolName: event.name,
        success: event.result.success,
        durationMs,
        errorCode: event.result.error?.code,
        createdAt,
      }));

      scheduleWrite("record conversation", () => deps.analytics.recordConversation({
        agentId: ctx.session.agentId,
        sessionId: ctx.session.sessionId,
        taskId,
        role: "tool",
        content: formatToolResultContent(event.result),
        toolName: event.name,
        toolCallId: event.callId,
        createdAt,
      }));
    }

    return resolution;
  };
}
