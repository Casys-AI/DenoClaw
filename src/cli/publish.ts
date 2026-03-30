import type { AgentEntry } from "../shared/types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";
import { ask, confirm, error, print, success } from "./prompt.ts";
import { cliFlags, output, outputError } from "./output.ts";
import { generateAgentEntrypoint } from "./setup.ts";

const SUBHOSTING_API = "https://api.deno.com/v2";

/**
 * Publish one or all agents to Deno Subhosting (v2 API).
 * Each agent gets its own Subhosting project + deployment.
 */
export async function publishAgents(agentName?: string): Promise<void> {
  const config = await getConfigOrDefault();

  // Resolve Subhosting credentials
  const orgId = Deno.env.get("DENO_SUBHOSTING_ORG_ID") ||
    config.deploy?.org ||
    (cliFlags().interactive
      ? await ask("Subhosting Organization ID")
      : undefined);
  const token = Deno.env.get("DENO_SUBHOSTING_TOKEN") ||
    (cliFlags().interactive
      ? await ask("Subhosting Access Token")
      : undefined);

  if (!orgId || !token) {
    outputError(
      "MISSING_CREDENTIALS",
      "Subhosting org ID and token are required. Set DENO_SUBHOSTING_ORG_ID and DENO_SUBHOSTING_TOKEN, or pass interactively.",
    );
    return;
  }

  // Build list of agents to publish
  const wsRegistry: Record<string, AgentEntry> =
    await WorkspaceLoader.buildRegistry();
  let agentsToPublish: [string, AgentEntry][];

  if (agentName) {
    const entry = wsRegistry[agentName];
    if (!entry) {
      outputError(
        "AGENT_NOT_FOUND",
        `Agent "${agentName}" not found in workspace.`,
      );
      return;
    }
    agentsToPublish = [[agentName, entry]];
  } else {
    agentsToPublish = Object.entries(wsRegistry);
    if (agentsToPublish.length === 0) {
      outputError("NO_AGENTS", "No agents in workspace.");
      return;
    }
    print(
      `Found ${agentsToPublish.length} agent(s): ${agentsToPublish.map(([n]) => n).join(", ")}`,
    );
    if (!await confirm("Publish all to Subhosting?")) return;
  }

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const results: {
    id: string;
    ok: boolean;
    domain?: string;
    error?: string;
  }[] = [];

  for (const [id, entry] of agentsToPublish) {
    print(`\n── Publishing ${id} ──`);

    const model = entry.model || config.agents.defaults.model;
    const perms = entry.sandbox?.allowedPermissions || ["read", "write", "run"];

    // 1. Create or find the Subhosting project
    const projectId = await ensureProject(orgId, id, headers);
    if (!projectId) {
      error(`${id}: failed to create/find Subhosting project`);
      results.push({ id, ok: false, error: "project creation failed" });
      continue;
    }

    // 2. Generate entrypoint and deploy
    const entrypoint = generateAgentEntrypoint(id, model, perms);

    print(`  Deploying (model: ${model}, perms: [${perms.join(",")}])...`);
    const deployRes = await fetch(
      `${SUBHOSTING_API}/projects/${projectId}/deployments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          entryPointUrl: "main.ts",
          assets: {
            "main.ts": {
              kind: "file",
              content: entrypoint,
              encoding: "utf-8",
            },
          },
          envVars: {
            DENOCLAW_AGENT_ID: id,
            DENOCLAW_MODEL: model,
          },
        }),
      },
    );

    if (!deployRes.ok) {
      const body = await deployRes.text();
      error(`${id}: deployment failed (${deployRes.status}) ${body}`);
      results.push({ id, ok: false, error: body });
      continue;
    }

    const deployment = (await deployRes.json()) as {
      id: string;
      domainMappings?: { domain: string }[];
    };
    const domain = deployment.domainMappings?.[0]?.domain;

    success(`${id} deployed (${deployment.id})`);
    if (domain) print(`  URL: https://${domain}`);

    results.push({ id, ok: true, domain });
  }

  // Save org for future use
  if (!config.deploy) config.deploy = {};
  config.deploy.org = orgId;
  await saveConfig(config);

  const published = results.filter((r) => r.ok).length;
  output(
    { published, total: results.length, results },
    `\n✓ ${published}/${results.length} agent(s) published to Subhosting`,
  );
}

/** Create a Subhosting project if it doesn't exist, return its ID. */
async function ensureProject(
  orgId: string,
  agentName: string,
  headers: Record<string, string>,
): Promise<string | null> {
  // Try to create
  const createRes = await fetch(
    `${SUBHOSTING_API}/organizations/${orgId}/projects`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ name: agentName }),
    },
  );

  if (createRes.ok) {
    const project = (await createRes.json()) as { id: string };
    success(`  Project created: ${project.id}`);
    return project.id;
  }

  const body = await createRes.text();
  if (body.includes("already exists")) {
    print("  Project already exists, reusing.");
  } else {
    error(`  Project creation failed: ${createRes.status} ${body}`);
    return null;
  }

  // Find existing project
  const listRes = await fetch(
    `${SUBHOSTING_API}/organizations/${orgId}/projects`,
    { headers },
  );
  if (!listRes.ok) return null;

  const projects = (await listRes.json()) as { id: string; name: string }[];
  const found = projects.find((p) => p.name === agentName);
  return found?.id ?? null;
}
