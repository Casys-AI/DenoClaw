import type { AgentEntry } from "../../shared/types.ts";
import { AgentStore } from "../agent_store.ts";

export interface BrokerAgentRegistryDeps {
  getKv(): Promise<Deno.Kv>;
}

export class BrokerAgentRegistry {
  constructor(private readonly deps: BrokerAgentRegistryDeps) {}

  async saveAgentConfig(agentId: string, config: AgentEntry): Promise<void> {
    const kv = await this.deps.getKv();
    await new AgentStore(kv).set(agentId, config);
  }

  async getAgentConfig(agentId: string): Promise<AgentEntry | null> {
    const kv = await this.deps.getKv();
    return await new AgentStore(kv).get(agentId);
  }

  async getAgentConfigEntry(
    agentId: string,
  ): Promise<Deno.KvEntryMaybe<AgentEntry>> {
    const kv = await this.deps.getKv();
    return await new AgentStore(kv).getEntry(agentId);
  }

  async saveAgentEndpoint(agentId: string, endpoint: string): Promise<void> {
    const kv = await this.deps.getKv();
    await kv.set(["agents", agentId, "endpoint"], endpoint);
  }

  async getAgentEndpoint(agentId: string): Promise<string | null> {
    const kv = await this.deps.getKv();
    const entry = await kv.get<string>(["agents", agentId, "endpoint"]);
    return typeof entry.value === "string" && entry.value.length > 0
      ? entry.value
      : null;
  }
}
