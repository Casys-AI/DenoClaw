import type { Message } from "../../shared/types.ts";

/**
 * Agent memory access port (DDD).
 * Manages conversation history (session-scoped) and semantic recall.
 * Long-term facts have been replaced by Mastra working memory (WorkingMemoryPort).
 */
export interface MemoryPort {
  load(): Promise<void>;
  close(): void;

  // Conversations (async)
  addMessage(message: Message): Promise<void>;
  getMessages(): Promise<Message[]>;
  getRecentMessages(count: number): Promise<Message[]>;
  clear(): Promise<void>;
  readonly count: number;

  // Semantic search
  semanticRecall(query: string, topK?: number): Promise<Message[]>;
}
