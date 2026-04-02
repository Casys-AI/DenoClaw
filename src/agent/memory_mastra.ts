// src/agent/memory_mastra.ts
// Requires: @mastra/memory, @mastra/pg in deno.json imports (added in Task 13)

import type { Message } from "../shared/types.ts";
import type { LongTermFact, MemoryPort } from "./memory_port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import { log } from "../shared/log.ts";

export interface MastraMemoryConfig {
  connectionString: string;
  embedder: EmbedderPort;
  lastMessages?: number;
  semanticRecall?: { topK: number; messageRange: number };
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
  createThread(opts: { threadId: string }): Promise<void>;
  deleteThread(opts: { threadId: string }): Promise<void>;
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
  private mastra: MastraMemoryInstance | null = null;
  private threadId: string;
  private config: MastraMemoryConfig;
  private messageCount = 0;

  constructor(agentId: string, sessionId: string, config: MastraMemoryConfig) {
    this.threadId = `${agentId}:${sessionId}`;
    this.config = config;
  }

  private async getMastra(): Promise<MastraMemoryInstance> {
    if (this.mastra) return this.mastra;
    const { Memory } = await import("@mastra/memory");
    const { PgStore, PgVector } = await import("@mastra/pg");
    this.mastra = new Memory({
      storage: new PgStore({
        id: `denoclaw-storage`,
        connectionString: this.config.connectionString,
      }),
      vector: new PgVector({
        id: `denoclaw-vector`,
        connectionString: this.config.connectionString,
      }),
      embedder: toMastraEmbedder(this.config.embedder),
      options: {
        lastMessages: this.config.lastMessages ?? 50,
        semanticRecall: this.config.semanticRecall ?? { topK: 3, messageRange: 2 },
      },
    }) as unknown as MastraMemoryInstance;
    return this.mastra;
  }

  async load(): Promise<void> {
    try {
      const mastra = await this.getMastra();
      const existing = await mastra.getThreadById({ threadId: this.threadId });
      if (!existing) {
        await mastra.createThread({ threadId: this.threadId });
      }
    } catch (e) {
      log.error(`MastraMemory: failed to load thread ${this.threadId}`, e);
    }
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
  }

  async getMessages(): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.recall({ threadId: this.threadId });
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
    const mastra = await this.getMastra();
    await mastra.deleteThread({ threadId: this.threadId });
    await mastra.createThread({ threadId: this.threadId });
    this.messageCount = 0;
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

  async remember(fact: Omit<LongTermFact, "timestamp">): Promise<void> {
    await this.addMessage({
      role: "system",
      content: `[memory:${fact.topic}] ${fact.content}`,
    });
  }

  async recallTopic(topic: string, _limit?: number): Promise<LongTermFact[]> {
    const messages = await this.semanticRecall(`topic: ${topic}`, 5);
    return messages
      .filter((m) => m.content.startsWith(`[memory:${topic}]`))
      .map((m) => ({
        topic,
        content: m.content.replace(`[memory:${topic}] `, ""),
        timestamp: new Date().toISOString(),
      }));
  }

  async listTopics(): Promise<string[]> {
    const messages = await this.getMessages();
    const topics = new Set<string>();
    for (const m of messages) {
      const match = m.content.match(/^\[memory:([^\]]+)\]/);
      if (match) topics.add(match[1]);
    }
    return [...topics];
  }

  forgetTopic(_topic: string): Promise<void> {
    log.warn("MastraMemory: forgetTopic not supported in v1");
    return Promise.resolve();
  }
}
