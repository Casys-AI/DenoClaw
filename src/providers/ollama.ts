import type { LLMResponse, Message, ToolDefinition } from "../types.ts";
import { BaseProvider } from "./base.ts";
import { ProviderError } from "../utils/errors.ts";
import { log } from "../utils/log.ts";

/**
 * Ollama provider — native Ollama API format.
 *
 * Ollama Cloud uses /api/chat (not OpenAI-compatible /v1/chat/completions).
 * Works with both Ollama Cloud (https://api.ollama.com) and local (http://localhost:11434).
 */

interface OllamaResponse {
  model: string;
  message: { role: string; content: string };
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
    _temperature?: number,
    _maxTokens?: number,
    _tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const cleanModel = model.startsWith("ollama/") ? model.slice(7) : model;
    const url = `${this.apiBase}/api/chat`;

    log.debug(`Ollama: POST ${url} model=${cleanModel}`);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cleanModel,
          messages: messages.map((m) => ({
            role: m.role === "tool" ? "user" : m.role,
            content: m.content,
          })),
          stream: false,
        }),
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

      return {
        content: data.message.content,
        finishReason: data.done_reason || "stop",
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
