import type { AgentEntry } from "../shared/types.ts";

export const DENOCLAW_AGENT_PROTOCOL = "denoclaw.agent.v1";

export interface AgentSocketRegisterMessage {
  type: "register_agent";
  agentId: string;
  endpoint?: string;
  config?: AgentEntry;
}

export interface AgentSocketRegisteredMessage {
  type: "registered_agent";
  agentId: string;
}

export function createAgentSocketRegisterMessage(input: {
  agentId: string;
  endpoint?: string;
  config?: AgentEntry;
}): AgentSocketRegisterMessage {
  return {
    type: "register_agent",
    agentId: input.agentId,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.config ? { config: input.config } : {}),
  };
}

export function isAgentSocketRegisterMessage(
  value: unknown,
): value is AgentSocketRegisterMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "register_agent" &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0;
}

export function isAgentSocketRegisteredMessage(
  value: unknown,
): value is AgentSocketRegisteredMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "registered_agent" &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0;
}
