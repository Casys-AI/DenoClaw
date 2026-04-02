import type { Message } from "../../shared/types.ts";
import type { LlmResponseEvent, ToolResultEvent } from "../events.ts";
import { formatToolResultContent } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export interface MemoryWriter {
  addMessage(message: Message): Promise<void>;
}

export function memoryMiddleware(memory: MemoryWriter): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      if (e.toolCalls?.length) {
        await memory.addMessage({
          role: "assistant", content: e.content || "", tool_calls: e.toolCalls,
        });
      } else {
        await memory.addMessage({ role: "assistant", content: e.content });
      }
    }
    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      await memory.addMessage({
        role: "tool",
        content: formatToolResultContent(e.result),
        name: e.name,
        tool_call_id: e.callId,
      });
    }
    return next();
  };
}
