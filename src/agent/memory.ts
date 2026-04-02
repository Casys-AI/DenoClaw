import type { Message } from "../shared/types.ts";
import type { LongTermFact, MemoryPort } from "./memory_port.ts";
import { log } from "../shared/log.ts";

/**
 * KV-backed conversation memory (raw Deno KV, without kvdex).
 * Implements MemoryPort — usable as a lightweight fallback.
 * Long-term memory = no-op (no indexing in this implementation).
 */
export class Memory implements MemoryPort {
  private sessionId: string;
  private messages: Message[] = [];
  private maxMessages: number;
  private kv: Deno.Kv | null = null;
  private kvPath?: string;

  constructor(sessionId: string, maxMessages = 100, kvPath?: string) {
    this.sessionId = sessionId;
    this.maxMessages = maxMessages;
    this.kvPath = kvPath;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      this.kv = await Deno.openKv(this.kvPath);
    }
    return this.kv;
  }

  private kvKey(): Deno.KvKey {
    return ["memory", this.sessionId];
  }

  async load(): Promise<void> {
    try {
      const kv = await this.getKv();
      const entry = await kv.get<Message[]>(this.kvKey());
      if (entry.value) {
        this.messages = entry.value;
        log.debug(
          `Memory loaded: ${this.messages.length} messages (${this.sessionId})`,
        );
      }
    } catch (e) {
      log.error(`Failed to load memory (${this.sessionId})`, e);
      this.messages = [];
    }
  }

  private async save(): Promise<void> {
    try {
      const kv = await this.getKv();
      await kv.set(this.kvKey(), this.messages);
    } catch (e) {
      log.error(`Failed to save memory (${this.sessionId})`, e);
    }
  }

  async addMessage(message: Message): Promise<void> {
    this.messages.push(message);

    if (this.messages.length > this.maxMessages) {
      const system = this.messages.filter((m) => m.role === "system");
      const rest = this.messages.filter((m) => m.role !== "system").slice(
        -this.maxMessages,
      );
      this.messages = [...system, ...rest];
    }

    await this.save();
  }

  async getMessages(): Promise<Message[]> {
    return [...this.messages];
  }

  async getRecentMessages(count: number): Promise<Message[]> {
    return this.messages.slice(-count);
  }

  async semanticRecall(_query: string, _topK?: number): Promise<Message[]> {
    return [];
  }

  async clear(): Promise<void> {
    this.messages = [];
    await this.save();
  }

  get count(): number {
    return this.messages.length;
  }

  close(): void {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }

  // Long-term memory — no-op in this implementation (no raw-KV indexing)
  remember(_fact: Omit<LongTermFact, "timestamp">): Promise<void> {
    return Promise.resolve();
  }
  recallTopic(_topic: string, _limit?: number): Promise<LongTermFact[]> {
    return Promise.resolve([]);
  }
  listTopics(): Promise<string[]> {
    return Promise.resolve([]);
  }
  forgetTopic(_topic: string): Promise<void> {
    return Promise.resolve();
  }
}
