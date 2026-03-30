import type { AgentEntry } from "../shared/types.ts";
import { getConfigOrDefault } from "../config/mod.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";
import { confirm, error, print, success } from "./prompt.ts";
import { output, outputError } from "./output.ts";

/**
 * Publish one or all agents to the remote broker.
 * Uses the /api/agents endpoint (same as sync-agents script).
 */
export async function publishAgents(agentName?: string): Promise<void> {
  const config = await getConfigOrDefault();
  const brokerUrl = config.deploy?.app
    ? `https://${config.deploy.app}.deno.dev`
    : undefined;
  const apiToken = Deno.env.get("DENOCLAW_API_TOKEN");

  if (!brokerUrl) {
    outputError("NO_BROKER", "No broker deployed. Run 'denoclaw deploy' first.");
    return;
  }
  if (!apiToken) {
    outputError("NO_TOKEN", "DENOCLAW_API_TOKEN not set. Set it in .env or environment.");
    return;
  }

  // Build list of agents to publish
  const wsRegistry: Record<string, AgentEntry> = await WorkspaceLoader.buildRegistry();
  let agentsToPublish: [string, AgentEntry][];

  if (agentName) {
    const entry = wsRegistry[agentName];
    if (!entry) {
      outputError("AGENT_NOT_FOUND", `Agent "${agentName}" not found in workspace.`);
      return;
    }
    agentsToPublish = [[agentName, entry]];
  } else {
    agentsToPublish = Object.entries(wsRegistry);
    if (agentsToPublish.length === 0) {
      outputError("NO_AGENTS", "No agents in workspace.");
      return;
    }
    print(`Found ${agentsToPublish.length} agent(s): ${agentsToPublish.map(([n]) => n).join(", ")}`);
    if (!await confirm("Publish all?")) return;
  }

  const headers = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const [id, entry] of agentsToPublish) {
    const res = await fetch(`${brokerUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: id, config: entry }),
    });

    if (res.ok) {
      success(`${id} published`);
      results.push({ id, ok: true });
    } else {
      const text = await res.text();
      error(`${id} failed: ${res.status} ${text}`);
      results.push({ id, ok: false, error: text });
    }
  }

  output(
    { published: results.filter((r) => r.ok).length, total: results.length, results },
    `\n✓ ${results.filter((r) => r.ok).length}/${results.length} agent(s) published to ${brokerUrl}`,
  );
}
