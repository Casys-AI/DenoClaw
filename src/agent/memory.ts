import type { Message } from "../shared/types.ts";
import { log } from "../shared/log.ts";

/**
 * KV-backed conversation memory.
 * Uses Deno KV instead of JSON files — works locally and on Deno Deploy.
 */
export class Memory {
  private sessionId: string;
  private messages: Message[] = [];
  private maxMessages: number;
  private kv: Deno.Kv | null = null;

  constructor(sessionId: string, maxMessages = 100) {
    this.sessionId = sessionId;
    this.maxMessages = maxMessages;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      this.kv = await Deno.openKv();
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
        log.debug(`Mémoire chargée : ${this.messages.length} messages (${this.sessionId})`);
      }
    } catch (e) {
      log.error(`Échec chargement mémoire (${this.sessionId})`, e);
      this.messages = [];
    }
  }

  private async save(): Promise<void> {
    try {
      const kv = await this.getKv();
      await kv.set(this.kvKey(), this.messages);
    } catch (e) {
      log.error(`Échec sauvegarde mémoire (${this.sessionId})`, e);
    }
  }

  async addMessage(message: Message): Promise<void> {
    this.messages.push(message);

    if (this.messages.length > this.maxMessages) {
      const system = this.messages.filter((m) => m.role === "system");
      const rest = this.messages.filter((m) => m.role !== "system").slice(-this.maxMessages);
      this.messages = [...system, ...rest];
    }

    await this.save();
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getRecentMessages(count: number): Message[] {
    return this.messages.slice(-count);
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
}
