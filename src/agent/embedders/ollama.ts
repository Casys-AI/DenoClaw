import type { EmbedderPort } from "../embedder_port.ts";
import { ProviderError } from "../../shared/errors.ts";

export class OllamaEmbedder implements EmbedderPort {
  readonly dimension: number;
  readonly modelName: string;
  private apiKey?: string;

  constructor(
    private baseUrl: string,
    model = "nomic-embed-text",
    dimension = 768,
    apiKey?: string,
  ) {
    this.modelName = model;
    this.dimension = dimension;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model: this.modelName, input: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable)");
        throw new ProviderError(
          "OLLAMA_EMBED_FAILED",
          { status: res.status, model: this.modelName, body: body.slice(0, 200) },
          "Check Ollama server availability and model name",
        );
      }
      const body = await res.json();
      if (!Array.isArray(body.embeddings) || body.embeddings.length === 0) {
        throw new ProviderError(
          "OLLAMA_EMBED_INVALID_RESPONSE",
          { model: this.modelName, body: JSON.stringify(body).slice(0, 200) },
          "Ollama returned an unexpected response shape",
        );
      }
      return body.embeddings[0];
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ProviderError(
          "OLLAMA_EMBED_TIMEOUT",
          { model: this.modelName, timeoutMs: 10_000 },
          "Ollama embed timed out — check server load or increase timeout",
        );
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model: this.modelName, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable)");
        throw new ProviderError(
          "OLLAMA_EMBED_FAILED",
          { status: res.status, model: this.modelName, body: body.slice(0, 200), batch: true },
          "Check Ollama server availability and model name",
        );
      }
      const body = await res.json();
      if (!Array.isArray(body.embeddings) || body.embeddings.length === 0) {
        throw new ProviderError(
          "OLLAMA_EMBED_INVALID_RESPONSE",
          { model: this.modelName, body: JSON.stringify(body).slice(0, 200), batch: true },
          "Ollama returned an unexpected response shape",
        );
      }
      return body.embeddings;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ProviderError(
          "OLLAMA_EMBED_TIMEOUT",
          { model: this.modelName, timeoutMs: 10_000, batch: true },
          "Ollama embed batch timed out — check server load or increase timeout",
        );
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}
