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

export type GetMessagesFn = () => Promise<Message[]>;

export interface LlmMiddlewareDeps {
  getMessages: GetMessagesFn;
  complete: CompleteFn;
}

export function llmMiddleware(deps: LlmMiddlewareDeps): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== "llm_request") return next();
    const req = ctx.event as LlmRequestEvent;
    const messages = await deps.getMessages();
    const response = await deps.complete(
      messages, req.config.model, req.config.temperature,
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
