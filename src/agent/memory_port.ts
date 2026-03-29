import type { Message } from "../shared/mod.ts";

export interface LongTermFact {
  topic: string;
  content: string;
  source?: "user" | "agent" | "tool";
  confidence?: number;
  timestamp: string;
}

/**
 * Agent memory access port (DDD).
 * Two facets: conversations (session-scoped) + long-term facts (agent-scoped).
 * getMessages() and getRecentMessages() are synchronous (in-memory cache).
 */
export interface MemoryPort {
  load(): Promise<void>;
  close(): void;

  // Conversations
  addMessage(message: Message): Promise<void>;
  getMessages(): Message[];
  getRecentMessages(count: number): Message[];
  clear(): Promise<void>;
  readonly count: number;

  // Long-term memory
  remember(fact: Omit<LongTermFact, "timestamp">): Promise<void>;
  recall(topic: string, limit?: number): Promise<LongTermFact[]>;
  listTopics(): Promise<string[]>;
  forgetTopic(topic: string): Promise<void>;
}
