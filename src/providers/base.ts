import type { LLMResponse, Message, ToolCall, ToolDefinition } from "../types.ts";
import { ProviderError } from "../utils/errors.ts";
import { log } from "../utils/log.ts";

// ── Response shapes ───────────────────────────────────────

interface OpenAIChoice {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}
interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface AnthropicContent { type: string; text?: string; id?: string; name?: string; input?: unknown }
interface AnthropicResponse {
  content: AnthropicContent[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

// ── Base ──────────────────────────────────────────────────

export abstract class BaseProvider {
  protected apiKey: string;
  protected apiBase: string;

  constructor(apiKey: string, apiBase?: string) {
    this.apiKey = apiKey;
    this.apiBase = apiBase || this.getDefaultApiBase();
  }

  protected abstract getDefaultApiBase(): string;

  abstract complete(
    messages: Message[],
    model: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse>;

  protected async post<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${this.apiBase}${path}`;
    log.debug(`POST ${url}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError("LLM_HTTP_ERROR", { status: res.status, body: text.slice(0, 500), url }, "Check API key and model name");
    }

    return await res.json() as T;
  }
}

// ── OpenAI-compatible (OpenAI, OpenRouter, DeepSeek, Groq…) ─

export class OpenAICompatProvider extends BaseProvider {
  private defaultBase: string;

  constructor(apiKey: string, apiBase?: string, defaultBase = "https://api.openai.com/v1") {
    super(apiKey, apiBase || defaultBase);
    this.defaultBase = defaultBase;
  }

  protected getDefaultApiBase(): string {
    return this.defaultBase;
  }

  async complete(
    messages: Message[],
    model: string,
    temperature = 0.7,
    maxTokens = 4096,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: model.includes("/") ? model.split("/").pop() : model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name && { name: m.name }),
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
      temperature,
      max_tokens: maxTokens,
    };

    if (tools?.length) body.tools = tools;

    const data = await this.post<OpenAIResponse>("/chat/completions", body);
    const choice = data.choices[0];
    const msg = choice.message;

    return {
      content: msg.content || "",
      toolCalls: msg.tool_calls,
      finishReason: choice.finish_reason,
      usage: data.usage
        ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
        : undefined,
    };
  }
}

// ── Anthropic ─────────────────────────────────────────────

export class AnthropicProvider extends BaseProvider {
  protected getDefaultApiBase(): string {
    return "https://api.anthropic.com/v1";
  }

  async complete(
    messages: Message[],
    model: string,
    temperature = 0.7,
    maxTokens = 4096,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const systemContent = messages.find((m) => m.role === "system")?.content || "";
    const nonSystem = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: model.startsWith("anthropic/") ? model.slice(10) : model,
      messages: nonSystem.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.role === "tool"
          ? [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]
          : m.content,
      })),
      temperature,
      max_tokens: maxTokens,
    };

    if (systemContent) body.system = systemContent;
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const data = await this.post<AnthropicResponse>("/messages", body, {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.apiKey,
    });

    // Parse content blocks
    let textContent = "";
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === "text") {
        textContent += block.text || "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id!,
          type: "function",
          function: {
            name: block.name!,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: data.stop_reason,
      usage: data.usage
        ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        }
        : undefined,
    };
  }
}
