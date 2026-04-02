import type { Message } from "../shared/types.ts";

export interface LongTermFact {
  topic: string;
  content: string;
  source?: "user" | "agent" | "tool";
  confidence?: number;
  timestamp: string;
}

/**
 * Agent memory access port (DDD).
 * Two facets: conversations (session-scoped, async) + long-term facts (agent-scoped).
 * All read methods are async to allow remote/KV-backed implementations.
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

  // Long-term facts
  remember(fact: Omit<LongTermFact, "timestamp">): Promise<void>;
  recallTopic(topic: string, limit?: number): Promise<LongTermFact[]>;
  listTopics(): Promise<string[]>;
  forgetTopic(topic: string): Promise<void>;
}
