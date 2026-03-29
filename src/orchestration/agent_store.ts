/**
 * AgentStore — KV-backed agent registry for Deploy mode.
 *
 * Stores agent configs in Deno.Kv, replaces file-based workspaces in production.
 * Used by the gateway for CRUD API and by the broker at boot to load agents.
 */

import type { AgentEntry } from "../shared/mod.ts";
import { log } from "../shared/log.ts";

const AGENT_PREFIX = ["config", "agents"];

export class AgentStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async get(agentId: string): Promise<AgentEntry | null> {
    const entry = await this.kv.get<AgentEntry>([...AGENT_PREFIX, agentId]);
    return entry.value;
  }

  async list(): Promise<Record<string, AgentEntry>> {
    const registry: Record<string, AgentEntry> = {};
    const iter = this.kv.list<AgentEntry>({ prefix: AGENT_PREFIX });
    for await (const entry of iter) {
      const agentId = entry.key[entry.key.length - 1] as string;
      registry[agentId] = entry.value;
    }
    return registry;
  }

  async set(agentId: string, config: AgentEntry): Promise<void> {
    await this.kv.set([...AGENT_PREFIX, agentId], config);
    log.info(`AgentStore: saved ${agentId}`);
  }

  async delete(agentId: string): Promise<boolean> {
    const entry = await this.kv.get([...AGENT_PREFIX, agentId]);
    if (!entry.value) return false;
    await this.kv.delete([...AGENT_PREFIX, agentId]);
    log.info(`AgentStore: deleted ${agentId}`);
    return true;
  }

  /** Import multiple agents at once (for sync from local). */
  async importAll(registry: Record<string, AgentEntry>): Promise<number> {
    let count = 0;
    for (const [agentId, config] of Object.entries(registry)) {
      await this.set(agentId, config);
      count++;
    }
    return count;
  }
}
