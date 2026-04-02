import type { EmbedderPort } from "../embedder_port.ts";

// fastembed is an EmbeddingModelV1<string> from the ai SDK (has doEmbed method).
// We type it as unknown to avoid importing ai types directly (transitive via @mastra/fastembed).
type FastembedModel = {
  doEmbed(options: { values: string[] }): PromiseLike<{ embeddings: number[][] }>;
};

let fastembedPromise: Promise<FastembedModel> | null = null;

function loadFastembed(): Promise<FastembedModel> {
  if (!fastembedPromise) {
    fastembedPromise = (async () => {
      const mod = await import("@mastra/fastembed");
      if (!mod.fastembed) {
        throw new Error(
          "@mastra/fastembed loaded but fastembed export is null/undefined — FFI may have failed",
        );
      }
      return mod.fastembed as unknown as FastembedModel;
    })();
  }
  return fastembedPromise;
}

export class MastraEmbedder implements EmbedderPort {
  readonly dimension = 384;
  readonly modelName = "fastembed";

  async embed(text: string): Promise<number[]> {
    const model = await loadFastembed();
    const result = await model.doEmbed({ values: [text] });
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const model = await loadFastembed();
    const result = await model.doEmbed({ values: texts });
    return result.embeddings;
  }
}
