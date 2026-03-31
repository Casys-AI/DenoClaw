#!/usr/bin/env -S deno run --allow-all --env
/**
 * Sync local agents to Deploy KV via the broker API.
 *
 * Reads agent configs from local KV (data/shared.db) and POSTs them
 * to the remote broker's /api/agents endpoint.
 *
 * Usage:
 *   deno task sync-agents <broker-url> <api-token>
 *
 * Example:
 *   deno task sync-agents https://denoclaw.deno.dev my-secret-token
 */

const brokerUrl = Deno.args[0];
const token = Deno.args[1];

if (!brokerUrl || !token) {
  console.error("Usage: deno task sync-agents <broker-url> <api-token>");
  Deno.exit(1);
}

// Read agents from local shared KV
const kv = await Deno.openKv("data/shared.db");

console.log("Reading agents from local KV...");

const agents: { id: string; status: string; model?: string }[] = [];
for await (const entry of kv.list({ prefix: ["agents"] })) {
  const key = entry.key;
  // Agent status entries are at ["agents", agentId, "status"]
  if (key.length === 3 && key[2] === "status") {
    const agentId = key[1] as string;
    const value = entry.value as { status: string; model?: string };
    agents.push({ id: agentId, status: value.status, model: value.model });
  }
}

if (agents.length === 0) {
  console.log("No agents found in local KV.");

  // Try reading from workspace files
  try {
    for await (const dir of Deno.readDir("data/agents")) {
      if (!dir.isDirectory) continue;
      try {
        const raw = await Deno.readTextFile(
          `data/agents/${dir.name}/agent.json`,
        );
        const config = JSON.parse(raw);
        agents.push({ id: dir.name, status: "config", model: config.model });
      } catch { /* skip */ }
    }
  } catch { /* no agents dir */ }
}

console.log(
  `Found ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`,
);

const headers = {
  "Authorization": `Bearer ${token}`,
  "Content-Type": "application/json",
};

let synced = 0;
for (const agent of agents) {
  // Build a minimal AgentEntry config
  const config = {
    model: agent.model || "ollama/nemotron",
    description: `Synced from local (${agent.status})`,
    sandbox: {
      backend: "local",
      allowedPermissions: ["read", "write", "run", "net"],
      execPolicy: {
        security: "allowlist",
        allowedCommands: ["git", "deno", "npm", "ls", "cat", "grep", "echo"],
      },
    },
  };

  const res = await fetch(`${brokerUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agentId: agent.id, config }),
  });

  if (res.ok) {
    console.log(`  ✓ ${agent.id} synced`);
    synced++;
  } else {
    console.error(`  ✗ ${agent.id} failed: ${res.status} ${await res.text()}`);
  }
}

console.log(`\nDone: ${synced}/${agents.length} agents synced to ${brokerUrl}`);
kv.close();
