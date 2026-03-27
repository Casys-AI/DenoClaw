import type { AgentCard, AgentSkill } from "./types.ts";
import type { AgentEntry } from "../../shared/types.ts";
import type { AgentsConfig } from "../../agent/types.ts";

/**
 * Generate A2A AgentCards from the DenoClaw agent registry.
 */

const TOOL_SKILLS: Record<string, AgentSkill> = {
  shell: {
    id: "shell_exec",
    name: "Shell Execution",
    description: "Execute shell commands in sandbox",
    tags: ["coding", "shell", "automation"],
  },
  read_file: {
    id: "file_read",
    name: "File Read",
    description: "Read file contents",
    tags: ["files", "data"],
  },
  write_file: {
    id: "file_write",
    name: "File Write",
    description: "Write content to files",
    tags: ["files", "coding"],
  },
  web_fetch: {
    id: "web_fetch",
    name: "Web Fetch",
    description: "Fetch content from URLs",
    tags: ["web", "data"],
  },
};

export function generateAgentCard(
  agentName: string,
  agent: AgentEntry,
  _defaults: AgentsConfig["defaults"],
  baseUrl: string,
): AgentCard {
  const perms = agent.sandbox?.allowedPermissions || [];

  // Build skills from sandbox permissions
  const skills: AgentSkill[] = [];

  if (perms.includes("run")) skills.push(TOOL_SKILLS.shell);
  if (perms.includes("read")) skills.push(TOOL_SKILLS.read_file);
  if (perms.includes("write")) skills.push(TOOL_SKILLS.write_file);
  if (perms.includes("net")) skills.push(TOOL_SKILLS.web_fetch);

  // Add a general skill for the agent's purpose
  if (agent.description) {
    skills.unshift({
      id: `agent_${agentName}`,
      name: agentName,
      description: agent.description,
      tags: ["agent", "ai"],
    });
  }

  return {
    name: agentName,
    description: agent.description || `DenoClaw agent: ${agentName}`,
    version: "1.0.0",
    protocolVersion: "1.0",
    url: `${baseUrl}/a2a/${agentName}`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    authentication: { schemes: ["Bearer"] },
    skills,
  };
}

export function generateAllCards(
  config: AgentsConfig,
  baseUrl: string,
): Record<string, AgentCard> {
  const cards: Record<string, AgentCard> = {};
  const registry = config.registry || {};

  for (const [name, agent] of Object.entries(registry)) {
    cards[name] = generateAgentCard(name, agent, config.defaults, baseUrl);
  }

  return cards;
}
