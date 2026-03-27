import type {
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from "../shared/types.ts";
import { BaseProvider } from "./base.ts";
import { ProviderError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

/**
 * Ollama provider — native Ollama API format.
 *
 * Ollama Cloud uses /api/chat (not OpenAI-compatible /v1/chat/completions).
 * Supports tool calling (function calling) natively.
 */

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider extends BaseProvider {
  protected getDefaultApiBase(): string {
    return "https://api.ollama.com";
  }

  async complete(
    messages: Message[],
    model: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const cleanModel = model.startsWith("ollama/") ? model.slice(7) : model;
    const url = `${this.apiBase}/api/chat`;

    log.debug(
      `Ollama: POST ${url} model=${cleanModel} tools=${tools?.length ?? 0}`,
    );
    if (tools?.length) {
      log.debug(
        `Ollama tools: ${JSON.stringify(tools.map((t) => t.function.name))}`,
      );
    }

    try {
      // Build request body
      const body: Record<string, unknown> = {
        model: cleanModel,
        messages: messages.map((m) => {
          if (m.role === "tool") {
            return {
              role: "tool",
              content: m.content,
              tool_name: m.name ?? "",
            };
          }
          if (m.role === "assistant" && m.tool_calls?.length) {
            return {
              role: "assistant",
              content: m.content || "",
              tool_calls: m.tool_calls.map((tc) => {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.function.arguments);
                } catch { /* keep empty */ }
                return {
                  function: { name: tc.function.name, arguments: args },
                };
              }),
            };
          }
          return { role: m.role, content: m.content };
        }),
        stream: false,
      };

      if (tools?.length) body.tools = tools;

      // Ollama uses options.temperature and options.num_predict (not top-level)
      const options: Record<string, unknown> = {};
      if (temperature !== undefined) options.temperature = temperature;
      if (maxTokens !== undefined) options.num_predict = maxTokens;
      if (Object.keys(options).length) body.options = options;

      log.debug(`Ollama request body: ${JSON.stringify(body).slice(0, 3000)}`);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new ProviderError(
          "LLM_HTTP_ERROR",
          { status: res.status, body: text.slice(0, 500), url },
          "Check Ollama API key and model name",
        );
      }

      const data = await res.json() as OllamaResponse;

      // Parse tool calls if present
      let toolCalls: ToolCall[] | undefined;
      if (data.message.tool_calls?.length) {
        toolCalls = data.message.tool_calls.map((tc, i) => ({
          id: `call_${i}_${Date.now()}`,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          },
        }));
      }

      return {
        content: data.message.content,
        toolCalls,
        finishReason: data.done_reason || (toolCalls ? "tool_calls" : "stop"),
        usage: {
          promptTokens: data.prompt_eval_count || 0,
          completionTokens: data.eval_count || 0,
          totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        },
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(
        "OLLAMA_ERROR",
        { model: cleanModel, message: (e as Error).message },
        "Check Ollama API availability",
      );
    }
  }
}
