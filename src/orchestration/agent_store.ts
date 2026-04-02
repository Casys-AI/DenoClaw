/**
 * AgentStore — KV-backed agent registry for Deploy mode.
 *
 * Stores agent configs in Deno.Kv using the canonical broker registry layout.
 * Used by the gateway for CRUD API and as the shared config store abstraction
 * for broker-side consumers.
 */

import type { AgentEntry } from "../shared/types.ts";
import { log } from "../shared/log.ts";
import { DenoClawError } from "../shared/errors.ts";

const AGENTS_PREFIX = ["agents"] as const;
const LEGACY_AGENTS_PREFIX = ["config", "agents"] as const;

export function createAgentConfigKey(agentId: string): Deno.KvKey {
  return ["agents", agentId, "config"];
}

export function createLegacyAgentConfigKey(agentId: string): Deno.KvKey {
  return ["config", "agents", agentId];
}

function isCanonicalAgentConfigKey(key: Deno.KvKey): key is [
  "agents",
  string,
  "config",
] {
  return key.length === 3 && key[0] === "agents" && key[2] === "config" &&
    typeof key[1] === "string";
}

export class AgentStore {
  constructor(private readonly kv: Deno.Kv) {}

  async get(agentId: string): Promise<AgentEntry | null> {
    const entry = await this.getEntry(agentId);
    return entry.value;
  }

  async getEntry(agentId: string): Promise<Deno.KvEntryMaybe<AgentEntry>> {
    const canonical = await this.kv.get<AgentEntry>(
      createAgentConfigKey(agentId),
    );
    if (canonical.value) return canonical;

    return await this.kv.get<AgentEntry>(createLegacyAgentConfigKey(agentId));
  }

  async list(): Promise<Record<string, AgentEntry>> {
    const registry: Record<string, AgentEntry> = {};

    for await (const entry of this.kv.list<AgentEntry>({ prefix: AGENTS_PREFIX })) {
      if (!isCanonicalAgentConfigKey(entry.key)) continue;
      const agentId = entry.key[1];
      registry[agentId] = entry.value;
    }

    for await (
      const entry of this.kv.list<AgentEntry>({ prefix: LEGACY_AGENTS_PREFIX })
    ) {
      const agentId = entry.key[entry.key.length - 1];
      if (typeof agentId !== "string" || agentId in registry) continue;
      registry[agentId] = entry.value;
    }

    return registry;
  }

  async set(agentId: string, config: AgentEntry): Promise<void> {
    const result = await this.kv.atomic()
      .set(createAgentConfigKey(agentId), config)
      .delete(createLegacyAgentConfigKey(agentId))
      .commit();
    if (!result.ok) {
      throw new DenoClawError(
        "AGENT_STORE_COMMIT_FAILED",
        { agentId, operation: "save" },
        "KV atomic commit failed — retry the operation",
      );
    }
    log.info(`AgentStore: saved ${agentId}`);
  }

  async delete(agentId: string): Promise<boolean> {
    const canonical = await this.kv.get(createAgentConfigKey(agentId));
    const legacy = await this.kv.get(createLegacyAgentConfigKey(agentId));
    if (!canonical.value && !legacy.value) return false;

    const result = await this.kv.atomic()
      .delete(createAgentConfigKey(agentId))
      .delete(createLegacyAgentConfigKey(agentId))
      .commit();
    if (!result.ok) {
      throw new DenoClawError(
        "AGENT_STORE_COMMIT_FAILED",
        { agentId, operation: "delete" },
        "KV atomic commit failed — retry the operation",
      );
    }
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
