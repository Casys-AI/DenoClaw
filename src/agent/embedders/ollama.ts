import type { EmbedderPort } from "../embedder_port.ts";

export class OllamaEmbedder implements EmbedderPort {
  readonly dimension: number;
  readonly modelName: string;

  constructor(
    private baseUrl: string,
    model = "nomic-embed-text",
    dimension = 768,
  ) {
    this.modelName = model;
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.modelName, input: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
    const body = await res.json();
    return body.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed batch failed: ${res.status}`);
    const body = await res.json();
    return body.embeddings;
  }
}
