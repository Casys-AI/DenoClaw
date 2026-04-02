// src/agent/memory_mastra.ts
// Requires: @mastra/memory, @mastra/pg in deno.json imports (added in Task 13)

import type { Message } from "../../shared/types.ts";
import type { MemoryPort } from "./port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import type { WorkingMemoryPort } from "../tools/working_memory.ts";
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

interface MastraMessageV1 {
  id: string;
  role: string;
  content: string | unknown;
  createdAt: Date;
  threadId?: string;
  resourceId?: string;
  type: "text" | "tool-call" | "tool-result";
  toolCallIds?: string[];
  toolCallArgs?: Record<string, unknown>[];
  toolNames?: string[];
}

interface MastraRememberResult {
  messages: MastraMessageV1[];
  messagesV2?: unknown[];
}

interface MastraThread {
  id: string;
  resourceId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

interface MastraMemoryInstance {
  query(opts: {
    threadId: string;
    resourceId?: string;
    selectBy?: {
      vectorSearchString?: string;
      last?: number | false;
    };
  }): Promise<{ messages: unknown[]; messagesV2?: unknown[] }>;
  rememberMessages(opts: {
    threadId: string;
    resourceId?: string;
    vectorMessageSearch?: string;
    config?: Record<string, unknown>;
  }): Promise<MastraRememberResult>;
  saveMessages(opts: { messages: MastraMessageV1[] }): Promise<MastraMessageV1[]>;
  getThreadById(opts: { threadId: string }): Promise<MastraThread | null>;
  saveThread(opts: { thread: MastraThread }): Promise<MastraThread>;
  deleteThread(threadId: string): Promise<void>;
  getWorkingMemory(opts: { threadId: string }): Promise<string | null>;
  updateWorkingMemory(opts: { threadId: string; workingMemory: string }): Promise<void>;
}

function toMastraMessage(msg: Message, threadId: string): MastraMessageV1 {
  return {
    id: crypto.randomUUID(),
    role: msg.role,
    content: msg.content,
    createdAt: new Date(),
    threadId,
    resourceId: threadId,
    type: msg.role === "tool" ? "tool-result" : "text",
    ...(msg.tool_call_id ? { toolCallIds: [msg.tool_call_id] } : {}),
  };
}

function fromMastraMessage(msg: MastraMessageV1): Message {
  return {
    role: msg.role as Message["role"],
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    ...(msg.toolCallIds?.[0] ? { tool_call_id: msg.toolCallIds[0] } : {}),
  };
}

function toMastraEmbedder(port: EmbedderPort) {
  // Return an AI SDK v1 EmbeddingModel-compatible object
  return {
    specificationVersion: "v1" as const,
    provider: "denoclaw",
    modelId: port.modelName,
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    doEmbed: async ({ values }: { values: string[] }) => {
      const embeddings = await port.embedBatch(values);
      return { embeddings };
    },
    // Expose dimension for Mastra vector index creation
    dimensions: port.dimension,
  };
}

export class MastraMemory implements MemoryPort, WorkingMemoryPort {
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
      const embedder = toMastraEmbedder(this.config.embedder);
      // Only enable vector/semantic recall when embedder has a valid positive dimension.
      // dimension=0 (e.g. NoopEmbedder) means no real embeddings — skip vector store.
      const hasVector = this.config.embedder.dimension > 0;
      const semanticRecallConfig = hasVector
        ? (this.config.semanticRecall ?? { topK: 3, messageRange: 2 })
        : false;
      const memoryConfig: Record<string, unknown> = {
        storage: new PostgresStore({ connectionString: this.config.connectionString }),
        embedder,
        options: {
          lastMessages: this.config.lastMessages ?? 50,
          semanticRecall: semanticRecallConfig,
          workingMemory: {
            enabled: true,
            template: this.config.workingMemoryTemplate ?? DEFAULT_WORKING_MEMORY_TEMPLATE,
          },
        },
      };
      if (hasVector) {
        memoryConfig.vector = new PgVector({ connectionString: this.config.connectionString });
      }
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
      const now = new Date();
      await mastra.saveThread({
        thread: {
          id: this.threadId,
          resourceId: this.threadId,
          title: this.threadId,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    // Initialize count from stored messages
    const result = await mastra.rememberMessages({ threadId: this.threadId });
    this.messageCount = result.messages.length;
  }

  close(): void {
    // PgStore connection pool handles cleanup
  }

  async addMessage(message: Message): Promise<void> {
    const mastra = await this.getMastra();
    await mastra.saveMessages({
      messages: [toMastraMessage(message, this.threadId)],
    });
    this.messageCount++;
    if (message.role === "user") {
      this.lastUserMessage = message.content;
    }
  }

  async getMessages(): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.rememberMessages({
      threadId: this.threadId,
      ...(this.lastUserMessage ? { vectorMessageSearch: this.lastUserMessage } : {}),
    });
    return result.messages.map(fromMastraMessage);
  }

  async getRecentMessages(count: number): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.query({
      threadId: this.threadId,
      selectBy: { last: count },
    });
    return (result.messages as MastraMessageV1[]).map(fromMastraMessage);
  }

  get count(): number {
    return this.messageCount;
  }

  async clear(): Promise<void> {
    try {
      const mastra = await this.getMastra();
      await mastra.deleteThread(this.threadId);
      const now = new Date();
      await mastra.saveThread({
        thread: {
          id: this.threadId,
          resourceId: this.threadId,
          title: this.threadId,
          createdAt: now,
          updatedAt: now,
        },
      });
      this.messageCount = 0;
      this.lastUserMessage = undefined;
    } catch (e) {
      log.error(`MastraMemory: failed to clear thread ${this.threadId}`, e);
      throw e;
    }
  }

  async semanticRecall(query: string, topK = 3): Promise<Message[]> {
    const mastra = await this.getMastra();
    const result = await mastra.rememberMessages({
      threadId: this.threadId,
      vectorMessageSearch: query,
      config: { semanticRecall: { topK, messageRange: 2 } },
    });
    return result.messages.map(fromMastraMessage);
  }

  async trimMessages(messages: Message[], maxTokens: number): Promise<Message[]> {
    // Use Mastra's TokenLimiterProcessor for accurate token counting
    try {
      const { TokenLimiterProcessor } = await import("@mastra/core/processors");
      const limiter = new TokenLimiterProcessor({ limit: maxTokens });
      const mastraMessages = messages.map((m) => toMastraMessage(m, this.threadId));
      const result = await limiter.processInput(mastraMessages as never);
      return (result as MastraMessageV1[]).map(fromMastraMessage);
    } catch {
      // Fallback: simple character-based trimming if TokenLimiter unavailable
      const system = messages.filter((m) => m.role === "system");
      const others = messages.filter((m) => m.role !== "system");
      const CHARS_PER_TOKEN = 4;
      const maxChars = maxTokens * CHARS_PER_TOKEN;
      let used = system.reduce((s, m) => s + m.content.length, 0);
      if (used >= maxChars) return system;
      const kept: Message[] = [];
      for (let i = others.length - 1; i >= 0; i--) {
        if (used + others[i].content.length > maxChars) break;
        kept.unshift(others[i]);
        used += others[i].content.length;
      }
      return [...system, ...kept];
    }
  }

  async getWorkingMemory(): Promise<string> {
    const mastra = await this.getMastra();
    const wm = await mastra.getWorkingMemory({ threadId: this.threadId });
    return wm ?? "";
  }

  async updateWorkingMemory(content: string): Promise<void> {
    const mastra = await this.getMastra();
    await mastra.updateWorkingMemory({ threadId: this.threadId, workingMemory: content });
  }
}
