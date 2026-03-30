import type { AgentEntry } from "../shared/types.ts";

export interface HasResolvedAgentRegistry {
  agents: {
    registry?: Record<string, AgentEntry>;
  };
}

export function getResolvedAgentRegistry(
  config: HasResolvedAgentRegistry,
): Record<string, AgentEntry> {
  return config.agents.registry ?? {};
}

export function getResolvedAgentEntry(
  config: HasResolvedAgentRegistry,
  agentId: string,
): AgentEntry | undefined {
  return getResolvedAgentRegistry(config)[agentId];
}

export function ensureResolvedAgentRegistry(
  config: HasResolvedAgentRegistry,
): Record<string, AgentEntry> {
  if (!config.agents.registry) {
    config.agents.registry = {};
  }
  return config.agents.registry;
}
