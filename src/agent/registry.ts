import type { AgentEntry } from "../shared/types.ts";

export type ResolvedAgentRegistry = Record<string, AgentEntry>;

export interface HasResolvedAgentRegistry {
  agents: {
    registry?: ResolvedAgentRegistry;
  };
}

export function getResolvedAgentRegistry(
  config: HasResolvedAgentRegistry,
): ResolvedAgentRegistry {
  return config.agents.registry ?? {};
}

export class AgentRuntimeRegistry {
  private registry: ResolvedAgentRegistry;

  constructor(initialRegistry: ResolvedAgentRegistry = {}) {
    this.registry = { ...initialRegistry };
  }

  listIds(): string[] {
    return Object.keys(this.registry);
  }

  has(agentId: string): boolean {
    return agentId in this.registry;
  }

  get(agentId: string): AgentEntry | undefined {
    return this.registry[agentId];
  }

  set(agentId: string, entry: AgentEntry): void {
    this.registry[agentId] = entry;
  }

  delete(agentId: string): void {
    delete this.registry[agentId];
  }

  snapshot(): ResolvedAgentRegistry {
    return { ...this.registry };
  }
}
