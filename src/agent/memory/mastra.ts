// src/agent/memory_mastra.ts
// Requires: @mastra/memory, @mastra/pg in deno.json imports (added in Task 13)

import type { Message } from "../../shared/types.ts";
import type { LongTermFact, MemoryPort } from "./port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import { log } from "../../shared/log.ts";

const DEFAULT_WORKING_MEMORY_TEMPLATE = `
# Agent Knowledge

## User Info
- Name:
- Preferences:
- Context:

## Project State
- Current Task:
- Key Facts:
- Decisions Made:

## Session
- Open Questions:
- Action Items:
`;

export interface MastraMemoryConfig {
  connectionString: string;
  embedder: EmbedderPort;
  lastMessages?: number;
  semanticRecall?: { topK: number; messageRange: number };
  workingMemoryTemplate?: string;
}

interface MastraMessage {
  id?: string;
  role: string;
  content: string;
  name?: string;
  toolCallId?: string;
  createdAt?: string;
}

interface MastraRecallResult {
  messages: MastraMessage[];
  totalMessages?: number;
}

interface MastraMemoryInstance {
  recall(opts: Record<string, unknown>): Promise<MastraRecallResult>;
  saveMessages(opts: { threadId: string; messages: MastraMessage[] }): Promise<void>;
  getThreadById(opts: { threadId: string }): Promise<unknown | null>;
  createThread(opts: Record<string, unknown>): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
}

function toMastraMessage(msg: Message): MastraMessage {
  return {
    role: msg.role === "tool" ? "tool" : msg.role,
    content: msg.content,
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.tool_call_id ? { toolCallId: msg.tool_call_id } : {}),
  };
}

function fromMastraMessage(msg: MastraMessage): Message {
  return {
    role: msg.role as Message["role"],
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
  };
}

function toMastraEmbedder(port: EmbedderPort) {
  return {
    embed: async (texts: string[]) => {
      const embeddings = await port.embedBatch(texts);
      return { embeddings };
    },
    dimensions: port.dimension,
  };
}

export class MastraMemory implements MemoryPort {
  private initPromise: Promise<MastraMemoryInstance> | null = null;
  private threadId: string;
  private config: MastraMemoryConfig;
  private messageCount = 0;
  private lastUserMessage: string | undefined;

  constructor(agentId: string, sessionId: string, config: MastraMemoryConfig) {
    this.threadId = `${agentId}:${sessionId}`;
    this.config = config;
  }

  private getMastra(): Promise<MastraMemoryInstance> {
    if (!this.initPromise) {
      this.initPromise = this.initMastra();
    }
    return this.initPromise;
  }

  private async initMastra(): Promise<MastraMemoryInstance> {
    try {
      const { Memory } = await import("@mastra/memory");
      const { PostgresStore, PgVector } = await import("@mastra/pg");
      const memoryConfig = {
        storage: new PostgresStore({ connectionString: this.config.connectionString }),
        vector: new PgVector({ connectionString: this.config.connectionString }),
        embedder: toMastraEmbedder(this.config.embedder),
        options: {
          lastMessages: this.config.lastMessages ?? 50,
          semanticRecall: this.config.semanticRecall ?? { topK: 3, messageRange: 2 },
          workingMemory: {
            enabled: true,
            template: this.config.workingMemoryTemplate ?? DEFAULT_WORKING_MEMORY_TEMPLATE,
          },
        },
      };
      const instance = new Memory(memoryConfig as unknown as ConstructorParameters<typeof Memory>[0]);
      return instance as unknown as MastraMemoryInstance;
    } catch (e) {
      this.initPromise = null; // allow retry on next call
      log.error(`MastraMemory: failed to initialize Pg backend (thread ${this.threadId})`, e);
      throw e;
    }
  }

  async load(): Promise<void> {
    // Let errors propagate — createMemory() catches and falls back to KV
    const mastra = await this.getMastra();
    const existing = await mastra.getThreadById({ threadId: this.threadId });
    if (!existing) {
      await mastra.createThread({ threadId: this.threadId, resourceId: this.threadId });
    }
    // Initialize count from stored messages
    const result = await mastra.recall({ threadId: this.threadId });
    this.messageCount = result.messages.length;
  }

  close(): void {
    // PgStore connection pool handles cleanup
  }

  async addMessage(message: Message): Promise<void> {
    const mastra = await this.getMastra();
    await mastra.saveMessages({
      threadId: this.threadId,
      messages: [toMastraMessage(message)],
    });
    this.messageCount++;
    if (message.role === "user") {
      this.lastUserMessage = message.content;
    }
  }

  async getMessages(): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.recall({
      threadId: this.threadId,
      ...(this.lastUserMessage ? { vectorSearchString: this.lastUserMessage } : {}),
    });
    return result.messages.map(fromMastraMessage);
  }

  async getRecentMessages(count: number): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.recall({ threadId: this.threadId, perPage: count });
    return result.messages.map(fromMastraMessage);
  }

  get count(): number {
    return this.messageCount;
  }

  async clear(): Promise<void> {
    try {
      const mastra = await this.getMastra();
      await mastra.deleteThread(this.threadId);
      await mastra.createThread({ threadId: this.threadId, resourceId: this.threadId });
      this.messageCount = 0;
      this.lastUserMessage = undefined;
    } catch (e) {
      log.error(`MastraMemory: failed to clear thread ${this.threadId}`, e);
      throw e;
    }
  }

  async semanticRecall(query: string, topK = 3): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.recall({
      threadId: this.threadId,
      vectorSearchString: query,
      threadConfig: { semanticRecall: { topK, messageRange: 2 } },
    });
    return result.messages.map(fromMastraMessage);
  }

  remember(fact: Omit<LongTermFact, "timestamp">): Promise<void> {
    // With working memory enabled, facts are managed by Mastra through
    // the working memory template. The agent updates it conversationally.
    log.debug(`MastraMemory: remember(${fact.topic}) — handled by working memory`);
    return Promise.resolve();
  }

  async recallTopic(topic: string, _limit?: number): Promise<LongTermFact[]> {
    try {
      const mastra = await this.getMastra();
      const result = await mastra.recall({
        threadId: this.threadId,
        vectorSearchString: topic,
        threadConfig: { semanticRecall: { topK: 5, messageRange: 0 } },
      });
      return result.messages
        .map(fromMastraMessage)
        .map((m) => ({
          topic,
          content: m.content,
          timestamp: new Date().toISOString(),
        }));
    } catch (e) {
      log.error(`MastraMemory: recallTopic failed (topic: ${topic})`, e);
      return [];
    }
  }

  listTopics(): Promise<string[]> {
    // Working memory replaces topic-based facts.
    // The agent's knowledge is in the working memory template.
    return Promise.resolve([]);
  }

  forgetTopic(_topic: string): Promise<void> {
    log.warn("MastraMemory: forgetTopic not supported — use working memory");
    return Promise.resolve();
  }
}
