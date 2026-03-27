import type { Message } from "../shared/types.ts";

export interface LongTermFact {
  topic: string;
  content: string;
  source?: "user" | "agent" | "tool";
  confidence?: number;
  timestamp: string;
}

/**
 * Port d'accès à la mémoire agent (DDD).
 * Deux facettes : conversations (session-scoped) + faits long-terme (agent-scoped).
 * getMessages() et getRecentMessages() sont synchrones (cache in-memory).
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
