import type { Session } from "./types.ts";
import { log } from "../shared/log.ts";

/**
 * KV-backed session manager — replaces file-based sessions.
 */
export class SessionManager {
  private kv: Deno.Kv | null = null;

  constructor(kv?: Deno.Kv) {
    if (kv) this.kv = kv;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  private key(id: string): Deno.KvKey {
    return ["sessions", id];
  }

  async getOrCreate(sessionId: string, userId: string, channelType = "cli"): Promise<Session> {
    const kv = await this.getKv();
    const entry = await kv.get<Session>(this.key(sessionId));

    if (entry.value) {
      const session = { ...entry.value, lastActivity: new Date().toISOString() };
      await kv.set(this.key(sessionId), session);
      return session;
    }

    const session: Session = {
      id: sessionId,
      userId,
      channelType,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      metadata: {},
    };

    await kv.set(this.key(sessionId), session);
    log.info(`Session créée : ${sessionId}`);
    return session;
  }

  async get(sessionId: string): Promise<Session | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Session>(this.key(sessionId));
    return entry.value;
  }

  async delete(sessionId: string): Promise<void> {
    const kv = await this.getKv();
    await kv.delete(this.key(sessionId));
    log.info(`Session supprimée : ${sessionId}`);
  }

  async listAll(): Promise<Session[]> {
    const kv = await this.getKv();
    const sessions: Session[] = [];
    for await (const entry of kv.list<Session>({ prefix: ["sessions"] })) {
      if (entry.value) sessions.push(entry.value);
    }
    return sessions;
  }

  async getActive(hours = 24): Promise<Session[]> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const all = await this.listAll();
    return all.filter((s) => s.lastActivity > cutoff);
  }

  async cleanup(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const all = await this.listAll();
    let count = 0;
    for (const s of all) {
      if (s.lastActivity < cutoff) {
        await this.delete(s.id);
        count++;
      }
    }
    log.info(`${count} session(s) nettoyée(s)`);
    return count;
  }

  close(): void {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }
}

let _sm: SessionManager | null = null;
export function getSessionManager(): SessionManager {
  if (!_sm) _sm = new SessionManager();
  return _sm;
}
