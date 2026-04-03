import type { EmbedderPort } from "../embedder_port.ts";
import { ProviderError } from "../../../shared/errors.ts";

export class OpenAIEmbedder implements EmbedderPort {
  readonly dimension: number;
  readonly modelName: string;

  constructor(
    private apiKey: string,
    model = "text-embedding-3-small",
    dimension = 1536,
  ) {
    this.modelName = model;
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.call([text]);
    return res[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.call(texts);
  }

  private async call(input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.modelName, input }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable)");
        throw new ProviderError(
          "OPENAI_EMBED_FAILED",
          { status: res.status, model: this.modelName, body: body.slice(0, 200) },
          "Check OpenAI API key and model name",
        );
      }
      const data = await res.json();
      return data.data.map((d: { embedding: number[] }) => d.embedding);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ProviderError(
          "OPENAI_EMBED_TIMEOUT",
          { model: this.modelName, timeoutMs: 15_000 },
          "OpenAI embed timed out",
        );
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}
