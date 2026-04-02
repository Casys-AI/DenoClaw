import { collection, kvdex, model } from "@olli/kvdex";
import type { Message } from "../../shared/types.ts";
import type { MemoryPort } from "./port.ts";
import { log } from "../../shared/log.ts";

type ConvMessageDoc = {
  sessionId: string;
  seq: number;
  role: string;
  content: string;
  name: string | undefined;
  tool_call_id: string | undefined;
  tool_calls_json: string | undefined;
  timestamp: string;
};

function openDb(kv: Deno.Kv) {
  return kvdex({
    kv,
    schema: {
      convMessages: collection(model<ConvMessageDoc>(), {
        indices: { sessionId: "secondary" },
      }),
    },
  });
}

type DbType = ReturnType<typeof openDb>;

/**
 * Agent memory structured via kvdex.
 * Indexed collections: conversations (by sessionId) + long-term facts (by topic).
 * Synchronized in-memory cache for sync getMessages().
 */
export class KvdexMemory implements MemoryPort {
  private _agentId: string;
  private sessionId: string;
  private maxMessages: number;
  private kvPath?: string;
  private kv: Deno.Kv | null = null;
  private db: DbType | null = null;
  private cache: Message[] = [];
  private seq = 0;

  constructor(
    agentId: string,
    sessionId: string,
    maxMessages = 100,
    kvPath?: string,
  ) {
    this._agentId = agentId;
    this.sessionId = sessionId;
    this.maxMessages = maxMessages;
    this.kvPath = kvPath;
  }

  get agentId(): string {
    return this._agentId;
  }

  private async getDb(): Promise<DbType> {
    if (!this.db) {
      this.kv = await Deno.openKv(this.kvPath);
      this.db = openDb(this.kv);
    }
    return this.db;
  }

  async load(): Promise<void> {
    try {
      const db = await this.getDb();
      const result = await db.convMessages.findBySecondaryIndex(
        "sessionId",
        this.sessionId,
      );
      const docs = result.result
        .filter((d) => d.value != null)
        .map((d) => d.value!)
        .sort((a, b) => a.seq - b.seq);

      this.cache = docs.map((d) => {
        const msg: Message = {
          role: d.role as Message["role"],
          content: d.content,
        };
        if (d.name) msg.name = d.name;
        if (d.tool_call_id) msg.tool_call_id = d.tool_call_id;
        if (d.tool_calls_json) msg.tool_calls = JSON.parse(d.tool_calls_json);
        return msg;
      });
      this.seq = docs.length > 0 ? docs[docs.length - 1].seq + 1 : 0;

      // Trim on load (KV may have more than maxMessages)
      if (this.cache.length > this.maxMessages) {
        const system = this.cache.filter((m) => m.role === "system");
        const rest = this.cache.filter((m) => m.role !== "system").slice(
          -this.maxMessages,
        );
        this.cache = [...system, ...rest];
      }

      log.debug(
        `KvdexMemory loaded: ${this.cache.length} messages (${this.sessionId})`,
      );
    } catch (e) {
      log.error(`Failed to load KvdexMemory (${this.sessionId})`, e);
      this.cache = [];
      this.seq = 0;
    }
  }

  async addMessage(message: Message): Promise<void> {
    this.cache.push(message);

    if (this.cache.length > this.maxMessages) {
      const system = this.cache.filter((m) => m.role === "system");
      const rest = this.cache.filter((m) => m.role !== "system").slice(
        -this.maxMessages,
      );
      this.cache = [...system, ...rest];
    }

    try {
      const db = await this.getDb();
      const doc: ConvMessageDoc = {
        sessionId: this.sessionId,
        seq: this.seq++,
        role: message.role,
        content: message.content,
        name: message.name,
        tool_call_id: message.tool_call_id,
        tool_calls_json: message.tool_calls
          ? JSON.stringify(message.tool_calls)
          : undefined,
        timestamp: new Date().toISOString(),
      };
      await db.convMessages.add(doc);
    } catch (e) {
      log.error(`Failed to write KvdexMemory (${this.sessionId})`, e);
    }
  }

  getMessages(): Promise<Message[]> {
    return Promise.resolve([...this.cache]);
  }

  getRecentMessages(count: number): Promise<Message[]> {
    return Promise.resolve(this.cache.slice(-count));
  }

  semanticRecall(_query: string, _topK?: number): Promise<Message[]> {
    return Promise.resolve([]);
  }

  async clear(): Promise<void> {
    this.cache = [];
    this.seq = 0;
    try {
      const db = await this.getDb();
      await db.convMessages.deleteMany({
        filter: (doc) => doc.value.sessionId === this.sessionId,
      });
    } catch (e) {
      log.error(`Failed to clear KvdexMemory (${this.sessionId})`, e);
    }
  }

  get count(): number {
    return this.cache.length;
  }

  close(): void {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
      this.db = null;
    }
  }
}
