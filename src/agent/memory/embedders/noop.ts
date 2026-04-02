import type { EmbedderPort } from "../embedder_port.ts";

export class NoopEmbedder implements EmbedderPort {
  readonly dimension = 0;
  readonly modelName = "noop";

  embed(_text: string): Promise<number[]> {
    return Promise.resolve([]);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => []));
  }
}
