import type { LLMResponse, Message, ToolDefinition } from "../../shared/types.ts";
import type { LlmRequestEvent, LlmResolution } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export type CompleteFn = (
  messages: Message[],
  model: string,
  temperature?: number,
  maxTokens?: number,
  tools?: ToolDefinition[],
) => Promise<LLMResponse>;

export function llmMiddleware(complete: CompleteFn): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== "llm_request") return next();
    const req = ctx.event as LlmRequestEvent;
    const response = await complete(
      req.messages, req.config.model, req.config.temperature,
      req.config.maxTokens, req.tools,
    );
    const resolution: LlmResolution = {
      type: "llm",
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      usage: response.usage,
    };
    return resolution;
  };
}
