import type { AgentEntry, ChannelRouting } from "../types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { ask, choose, confirm, error, print, success } from "./prompt.ts";

export async function listAgents(): Promise<void> {
  const config = await getConfigOrDefault();
  const registry = config.agents.registry || {};
  const agents = Object.entries(registry);

  if (agents.length === 0) {
    print("Aucun agent configuré. Utilisez 'denoclaw agent create <name>'.");
    return;
  }

  print("\n=== Agents ===\n");
  for (const [name, agent] of agents) {
    const model = agent.model || config.agents.defaults.model;
    const perms = agent.sandbox?.allowedPermissions?.join(",") || "defaults";
    const desc = agent.description || "";
    print(`  ${name}`);
    print(`    Modèle: ${model} | Sandbox: [${perms}]`);
    if (desc) print(`    ${desc}`);
    print("");
  }

  // Show channel → agent mappings
  const channels = Object.entries(config.channels);
  if (channels.length > 0) {
    print("=== Channels → Agents ===\n");
    for (const [chName, chConfig] of channels) {
      if (!chConfig || !("enabled" in chConfig) || !chConfig.enabled) continue;
      const agents = (chConfig as { agents?: string[] }).agents;
      const routing = (chConfig as { routing?: string }).routing || "direct";
      print(`  ${chName} → [${agents?.join(", ") || "default"}] (${routing})`);
    }
    print("");
  }
}

export async function createAgent(name?: string): Promise<void> {
  const config = await getConfigOrDefault();
  if (!config.agents.registry) config.agents.registry = {};

  const agentName = name || await ask("Nom de l'agent");
  if (!agentName) {
    error("Nom requis.");
    return;
  }

  if (config.agents.registry[agentName]) {
    if (!await confirm(`L'agent "${agentName}" existe déjà. Écraser ?`, false)) return;
  }

  const description = await ask("Description (ce que fait cet agent)");
  const model = await ask("Modèle LLM", config.agents.defaults.model);

  const permChoice = await choose("Permissions sandbox", [
    "read-only   — lecture seule (read)",
    "standard    — lecture, écriture, exécution (read, write, run)",
    "full        — tout (read, write, run, net)",
    "custom      — choisir manuellement",
  ]);

  let permissions: string[];
  const permKey = permChoice.split("—")[0].trim().split(/\s+/)[0];
  switch (permKey) {
    case "read-only": permissions = ["read"]; break;
    case "standard": permissions = ["read", "write", "run"]; break;
    case "full": permissions = ["read", "write", "run", "net"]; break;
    default: {
      const raw = await ask("Permissions (read,write,run,net,env,ffi)", "read,write,run");
      permissions = raw.split(",").map((s) => s.trim());
      break;
    }
  }

  const systemPrompt = await ask("System prompt (vide = défaut)");

  const entry: AgentEntry = {
    model: model !== config.agents.defaults.model ? model : undefined,
    description: description || undefined,
    systemPrompt: systemPrompt || undefined,
    sandbox: { allowedPermissions: permissions as AgentEntry["sandbox"] extends { allowedPermissions: infer T } ? T : never },
  };

  // Clean — cast for sandbox permissions
  (entry.sandbox as { allowedPermissions: string[] }).allowedPermissions = permissions;

  config.agents.registry[agentName] = entry;

  // Assign to a channel?
  if (await confirm("Assigner cet agent à un channel ?", false)) {
    const channelNames = Object.keys(config.channels).filter((k) => {
      const ch = config.channels[k as keyof typeof config.channels];
      return ch && "enabled" in ch && ch.enabled;
    });

    if (channelNames.length === 0) {
      print("  Aucun channel configuré. Lancez 'denoclaw setup channel' d'abord.");
    } else {
      const chChoice = await choose("Quel channel ?", channelNames);
      const ch = config.channels[chChoice as keyof typeof config.channels] as { agents?: string[]; routing?: ChannelRouting };
      if (!ch.agents) ch.agents = [];
      if (!ch.agents.includes(agentName)) ch.agents.push(agentName);

      if (ch.agents.length > 1 && !ch.routing) {
        const routeChoice = await choose("Mode de routing (plusieurs agents)", [
          "direct     — premier agent de la liste",
          "round-robin — distribue entre les agents",
          "by-intent  — un coordinateur route selon l'intention",
          "broadcast  — tous les agents reçoivent",
        ]);
        ch.routing = routeChoice.split("—")[0].trim().split(/\s+/)[0] as ChannelRouting;
      }
    }
  }

  await saveConfig(config);
  success(`Agent "${agentName}" créé.`);
  print(`\n  denoclaw agent list          — voir tous les agents`);
  print(`  denoclaw publish agent ${agentName}  — déployer sur Subhosting`);
}

export async function deleteAgent(name?: string): Promise<void> {
  const config = await getConfigOrDefault();
  if (!config.agents.registry) {
    error("Aucun agent configuré.");
    return;
  }

  const agentName = name || await ask("Nom de l'agent à supprimer");
  if (!agentName || !config.agents.registry[agentName]) {
    error(`Agent "${agentName}" introuvable.`);
    print(`  Agents disponibles : ${Object.keys(config.agents.registry).join(", ")}`);
    return;
  }

  if (!await confirm(`Supprimer l'agent "${agentName}" ?`, false)) return;

  delete config.agents.registry[agentName];

  // Remove from channel assignments
  for (const ch of Object.values(config.channels)) {
    if (ch && "agents" in ch) {
      const agents = (ch as { agents?: string[] }).agents;
      if (agents) {
        const idx = agents.indexOf(agentName);
        if (idx >= 0) agents.splice(idx, 1);
      }
    }
  }

  await saveConfig(config);
  success(`Agent "${agentName}" supprimé.`);
}
