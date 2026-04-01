import type { AgentDefaults } from "../agent/types.ts";
import type { PublishedWorkspaceSnapshot } from "../agent/published_workspace.ts";
import type { AgentEntry } from "../shared/types.ts";

export function materializePublishedEntry(
  entry: AgentEntry,
  defaults: AgentDefaults,
): AgentEntry {
  const privilegeElevation = entry.sandbox?.privilegeElevation
    ? {
      ...(defaults.sandbox?.privilegeElevation ?? {}),
      ...entry.sandbox.privilegeElevation,
    }
    : defaults.sandbox?.privilegeElevation;
  const sandbox = entry.sandbox
    ? {
      ...(defaults.sandbox ?? {}),
      ...entry.sandbox,
      allowedPermissions: entry.sandbox.allowedPermissions,
      ...(privilegeElevation ? { privilegeElevation } : {}),
    }
    : defaults.sandbox
    ? { ...defaults.sandbox }
    : undefined;

  return {
    ...entry,
    model: entry.model ?? defaults.model,
    temperature: entry.temperature ?? defaults.temperature,
    maxTokens: entry.maxTokens ?? defaults.maxTokens,
    systemPrompt: entry.systemPrompt ?? defaults.systemPrompt,
    ...(sandbox ? { sandbox } : {}),
  };
}

export function generateAgentEntrypoint(
  agentId: string,
  entry: AgentEntry,
  workspaceSnapshot?: PublishedWorkspaceSnapshot,
): string {
  const runtimeOptions = workspaceSnapshot
    ? { agentId, entry, workspaceSnapshot }
    : { agentId, entry };
  return `// Auto-generated DenoClaw Agent Runtime
// Agent: ${agentId} | Model: ${entry.model ?? "unknown"}

import { startDeployedAgentRuntime } from "./src/agent/deploy_runtime.ts";

await startDeployedAgentRuntime(${JSON.stringify(runtimeOptions, null, 2)});
`;
}
