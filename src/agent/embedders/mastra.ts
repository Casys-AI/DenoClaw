import type { EmbedderPort } from "../embedder_port.ts";

let fastembedModule: { embed: (texts: string[]) => Promise<{ embeddings: number[][] }> } | null =
  null;

async function loadFastembed() {
  if (!fastembedModule) {
    const mod = await import("@mastra/fastembed");
    fastembedModule = mod.fastembed;
  }
  return fastembedModule!;
}

export class MastraEmbedder implements EmbedderPort {
  readonly dimension = 384;
  readonly modelName = "fastembed";

  async embed(text: string): Promise<number[]> {
    const fe = await loadFastembed();
    const result = await fe.embed([text]);
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const fe = await loadFastembed();
    const result = await fe.embed(texts);
    return result.embeddings;
  }
}
