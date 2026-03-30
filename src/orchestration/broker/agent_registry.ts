import type { AgentEntry } from "../../shared/types.ts";

export interface BrokerAgentRegistryDeps {
  getKv(): Promise<Deno.Kv>;
}

export class BrokerAgentRegistry {
  constructor(private readonly deps: BrokerAgentRegistryDeps) {}

  async saveAgentConfig(agentId: string, config: AgentEntry): Promise<void> {
    const kv = await this.deps.getKv();
    await kv.set(["agents", agentId, "config"], config);
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
