export interface EmbedderPort {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly modelName: string;
}
