import type { AgentEntry, SandboxPermission } from "../shared/types.ts";
import {
  getConfigOrDefault,
  getPersistedConfigOrDefault,
  saveConfig,
} from "../config/mod.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";
import { ask, choose, confirm, error, print, success } from "./prompt.ts";

export async function listAgents(): Promise<void> {
  const config = await getConfigOrDefault();
  const persistedConfig = await getPersistedConfigOrDefault();
  const wsRegistry = await WorkspaceLoader.buildRegistry();
  const legacyRegistry = persistedConfig.agents.registry || {};
  const registry = { ...legacyRegistry, ...wsRegistry };
  const agents = Object.entries(registry);

  if (agents.length === 0) {
    print("No agents configured. Use 'denoclaw agent create <name>'.");
    return;
  }

  print("\n=== Agents ===\n");
  for (const [name, agent] of agents) {
    const isWorkspace = name in wsRegistry;
    const model = agent.model || config.agents.defaults.model;
    const perms = agent.sandbox?.allowedPermissions?.join(",") || "defaults";
    const peers = agent.peers?.join(",") || "none";
    const accept = agent.acceptFrom?.join(",") || "none";

    print(
      `  ${name}${agent.description ? ` — ${agent.description}` : ""}${
        isWorkspace ? " [workspace]" : " [legacy]"
      }`,
    );
    print(`    Model    : ${model}`);
    print(`    Sandbox  : [${perms}]`);
    print(`    Peers    : [${peers}]     (can send to)`);
    print(`    Accept   : [${accept}]    (accepts from)`);
    print("");
  }
}

/** Options for non-interactive agent creation. If provided, skips interactive prompts. */
export interface CreateAgentOptions {
  description?: string;
  model?: string;
  systemPrompt?: string;
  permissions?: string; // comma-separated: "read,write,run"
  peers?: string; // comma-separated: "bob,charlie"
  acceptFrom?: string; // comma-separated or "*"
  force?: boolean; // overwrite if exists
}

export async function createAgent(
  name?: string,
  opts?: CreateAgentOptions,
): Promise<void> {
  const config = await getConfigOrDefault();
  const persistedConfig = await getPersistedConfigOrDefault();
  const legacyRegistry = persistedConfig.agents.registry || {};
  const interactive = !opts ||
    (!opts.description && !opts.model && !opts.systemPrompt &&
      !opts.permissions && !opts.peers && !opts.acceptFrom && !opts.force);

  const agentName = name || (interactive ? await ask("Agent name") : "");
  if (!agentName) {
    error("Name is required.");
    return;
  }

  const workspaceExists = await WorkspaceLoader.exists(agentName);
  const legacyExists = !!legacyRegistry[agentName];
  if (workspaceExists || legacyExists) {
    if (opts?.force) { /* overwrite */ }
    else if (interactive) {
      if (
        !await confirm(`Agent "${agentName}" already exists. Overwrite?`, false)
      ) return;
    } else {
      error(`Agent "${agentName}" already exists. Use --force to overwrite.`);
      return;
    }
  }

  let description: string | undefined;
  let model: string | undefined;
  let systemPrompt: string | undefined;
  let permissions: string[];
  let peers: string[] = [];
  let acceptFrom: string[] = [];

  if (interactive) {
    print("\n── Identity ──\n");
    description = await ask("Description (what this agent does)") || undefined;
    model = await ask("LLM model", config.agents.defaults.model);
    systemPrompt = await ask("System prompt (empty = default)") || undefined;

    print("\n── Sandbox Permissions ──\n");
    const permChoice = await choose("Permission profile", [
      "read-only   — read only (read)",
      "standard    — read, write, execute (read, write, run)",
      "full        — everything (read, write, run, net)",
      "custom      — choose manually",
    ]);
    const permKey = permChoice.split("—")[0].trim().split(/\s+/)[0];
    switch (permKey) {
      case "read-only":
        permissions = ["read"];
        break;
      case "standard":
        permissions = ["read", "write", "run"];
        break;
      case "full":
        permissions = ["read", "write", "run", "net"];
        break;
      default: {
        const raw = await ask(
          "Permissions (read,write,run,net,env,ffi)",
          "read,write,run",
        );
        permissions = raw.split(",").map((s) => s.trim());
        break;
      }
    }

    print("\n── Inter-Agent Communication (closed by default) ──\n");
    const existingAgents = await WorkspaceLoader.listAll();
    const otherAgents = existingAgents.filter((n) => n !== agentName);
    if (otherAgents.length > 0) {
      print(`  Existing agents: ${otherAgents.join(", ")}`);
      const peersInput = await ask(
        "Can send tasks to (comma-separated names, empty = none)",
      );
      peers = peersInput ? peersInput.split(",").map((s) => s.trim()) : [];
      const acceptInput = await ask(
        "Accepts tasks from (* = all, empty = none)",
      );
      acceptFrom = acceptInput
        ? acceptInput.split(",").map((s) => s.trim())
        : [];
    } else {
      print(
        "  No other agents yet. You can configure peers later.",
      );
    }
  } else {
    description = opts?.description;
    model = opts?.model;
    systemPrompt = opts?.systemPrompt;
    permissions = opts?.permissions
      ? opts.permissions.split(",").map((s) => s.trim())
      : ["read", "write", "run"];
    peers = opts?.peers ? opts.peers.split(",").map((s) => s.trim()) : [];
    acceptFrom = opts?.acceptFrom
      ? opts.acceptFrom.split(",").map((s) => s.trim())
      : [];
  }

  const entry: AgentEntry = {
    description: description || undefined,
    model: model && model !== config.agents.defaults.model ? model : undefined,
    sandbox: { allowedPermissions: permissions as SandboxPermission[] },
    peers: peers.length > 0 ? peers : undefined,
    acceptFrom: acceptFrom.length > 0 ? acceptFrom : undefined,
  };

  await WorkspaceLoader.create(agentName, entry, systemPrompt);

  if (legacyExists) {
    delete legacyRegistry[agentName];
    if (Object.keys(legacyRegistry).length === 0) {
      delete persistedConfig.agents.registry;
    } else {
      persistedConfig.agents.registry = legacyRegistry;
    }
    await saveConfig(persistedConfig, { persistAgentRegistry: true });
  }

  success(`Agent "${agentName}" created in workspace.`);
}

export async function deleteAgent(
  name?: string,
  opts?: { yes?: boolean },
): Promise<void> {
  const persistedConfig = await getPersistedConfigOrDefault();
  const wsAgents = await WorkspaceLoader.listAll();
  const legacyRegistry = { ...(persistedConfig.agents.registry || {}) };
  const registryAgents = Object.keys(legacyRegistry);
  const allAgents = [...new Set([...wsAgents, ...registryAgents])];

  const agentName = name || await ask("Agent name to delete");
  if (!agentName || !allAgents.includes(agentName)) {
    error(`Agent "${agentName}" not found.`);
    print(`  Available agents: ${allAgents.join(", ")}`);
    return;
  }

  if (!opts?.yes && !await confirm(`Delete agent "${agentName}"?`, false)) {
    return;
  }

  // Delete workspace
  await WorkspaceLoader.delete(agentName);

  let changedLegacyRegistry = false;
  if (legacyRegistry[agentName]) {
    delete legacyRegistry[agentName];
    changedLegacyRegistry = true;
  }

  // Remove from peers/acceptFrom of legacy config agents.
  for (const agent of Object.values(legacyRegistry)) {
    if (agent.peers?.includes(agentName)) {
      agent.peers = agent.peers.filter((p) => p !== agentName);
      changedLegacyRegistry = true;
    }
    if (agent.acceptFrom?.includes(agentName)) {
      agent.acceptFrom = agent.acceptFrom.filter((p) => p !== agentName);
      changedLegacyRegistry = true;
    }
  }

  // Remove from peers/acceptFrom of workspace agents.
  for (const otherId of wsAgents) {
    if (otherId === agentName) continue;
    const ws = await WorkspaceLoader.load(otherId);
    if (!ws) continue;
    let changed = false;
    if (ws.entry.peers?.includes(agentName)) {
      ws.entry.peers = ws.entry.peers.filter((p) => p !== agentName);
      changed = true;
    }
    if (ws.entry.acceptFrom?.includes(agentName)) {
      ws.entry.acceptFrom = ws.entry.acceptFrom.filter((p) => p !== agentName);
      changed = true;
    }
    if (changed) {
      await WorkspaceLoader.create(otherId, ws.entry, ws.systemPrompt);
    }
  }

  if (changedLegacyRegistry) {
    if (Object.keys(legacyRegistry).length === 0) {
      delete persistedConfig.agents.registry;
    } else {
      persistedConfig.agents.registry = legacyRegistry;
    }
    await saveConfig(persistedConfig, { persistAgentRegistry: true });
  }

  success(
    `Agent "${agentName}" deleted (workspace${
      changedLegacyRegistry ? " + legacy config cleanup" : ""
    }, removed from peers).`,
  );
}
