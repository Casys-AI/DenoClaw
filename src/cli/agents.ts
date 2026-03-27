import type { AgentEntry, ChannelRouting, SandboxPermission } from "../shared/types.ts";
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
    const peers = agent.peers?.join(",") || "aucun";
    const accept = agent.acceptFrom?.join(",") || "aucun";
    const channels = agent.channels?.join(",") || "aucun";

    print(`  ${name}${agent.description ? ` — ${agent.description}` : ""}`);
    print(`    Modèle   : ${model}`);
    print(`    Sandbox  : [${perms}]`);
    print(`    Peers    : [${peers}]     (peut envoyer à)`);
    print(`    Accept   : [${accept}]    (accepte de)`);
    print(`    Channels : [${channels}]`);
    print("");
  }
}

/** Options for non-interactive agent creation. If provided, skips interactive prompts. */
export interface CreateAgentOptions {
  description?: string;
  model?: string;
  systemPrompt?: string;
  permissions?: string;  // comma-separated: "read,write,run"
  peers?: string;        // comma-separated: "bob,charlie"
  acceptFrom?: string;   // comma-separated or "*"
  force?: boolean;       // overwrite if exists
}

export async function createAgent(name?: string, opts?: CreateAgentOptions): Promise<void> {
  const config = await getConfigOrDefault();
  if (!config.agents.registry) config.agents.registry = {};
  const interactive = !opts ||
    (!opts.description && !opts.model && !opts.systemPrompt &&
     !opts.permissions && !opts.peers && !opts.acceptFrom && !opts.force);

  const agentName = name || (interactive ? await ask("Nom de l'agent") : "");
  if (!agentName) {
    error("Nom requis.");
    return;
  }

  if (config.agents.registry[agentName]) {
    if (opts?.force) { /* overwrite */ }
    else if (interactive) {
      if (!await confirm(`L'agent "${agentName}" existe déjà. Écraser ?`, false)) return;
    } else {
      error(`Agent "${agentName}" existe déjà. Utilisez --force pour écraser.`);
      return;
    }
  }

  let description: string | undefined;
  let model: string | undefined;
  let systemPrompt: string | undefined;
  let permissions: string[];
  let peers: string[] = [];
  let acceptFrom: string[] = [];
  let channels: string[] = [];
  let channelRouting: ChannelRouting = "direct";

  if (interactive) {
    // Interactive mode — prompts
    print("\n── Identité ──\n");
    description = await ask("Description (ce que fait cet agent)") || undefined;
    model = await ask("Modèle LLM", config.agents.defaults.model);
    systemPrompt = await ask("System prompt (vide = défaut)") || undefined;

    print("\n── Permissions Sandbox ──\n");
    const permChoice = await choose("Profil de permissions", [
      "read-only   — lecture seule (read)",
      "standard    — lecture, écriture, exécution (read, write, run)",
      "full        — tout (read, write, run, net)",
      "custom      — choisir manuellement",
    ]);
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

    print("\n── Communication inter-agents (fermé par défaut) ──\n");
    const otherAgents = Object.keys(config.agents.registry).filter((n) => n !== agentName);
    if (otherAgents.length > 0) {
      print(`  Agents existants : ${otherAgents.join(", ")}`);
      const peersInput = await ask("Peut envoyer des Tasks à (noms séparés par virgule, vide = aucun)");
      peers = peersInput ? peersInput.split(",").map((s) => s.trim()) : [];
      const acceptInput = await ask("Accepte des Tasks de (* = tous, vide = aucun)");
      acceptFrom = acceptInput ? acceptInput.split(",").map((s) => s.trim()) : [];
    } else {
      print("  Aucun autre agent. Vous pourrez configurer les peers plus tard.");
    }

    print("\n── Channels ──\n");
    const enabledChannels = Object.entries(config.channels)
      .filter(([_, ch]) => ch && "enabled" in ch && ch.enabled)
      .map(([n]) => n);
    if (enabledChannels.length > 0) {
      print(`  Channels actifs : ${enabledChannels.join(", ")}`);
      const chInput = await ask("Assigner à quels channels (virgule, vide = aucun)");
      channels = chInput ? chInput.split(",").map((s) => s.trim()) : [];
      if (channels.length > 0) {
        const routeChoice = await choose("Mode de routing", [
          "direct     — cet agent reçoit tous les messages",
          "by-intent  — un coordinateur route selon l'intention",
          "round-robin — alternance avec d'autres agents sur le même channel",
          "broadcast  — reçoit une copie de tous les messages",
        ]);
        channelRouting = routeChoice.split("—")[0].trim().split(/\s+/)[0] as ChannelRouting;
      }
    } else {
      print("  Aucun channel configuré. Lancez 'denoclaw setup channel' d'abord.");
    }
  } else {
    // Non-interactive mode — use options or defaults
    description = opts?.description;
    model = opts?.model;
    systemPrompt = opts?.systemPrompt;
    permissions = opts?.permissions ? opts.permissions.split(",").map((s) => s.trim()) : ["read", "write", "run"];
    peers = opts?.peers ? opts.peers.split(",").map((s) => s.trim()) : [];
    acceptFrom = opts?.acceptFrom ? opts.acceptFrom.split(",").map((s) => s.trim()) : [];
  }

  const entry: AgentEntry = {
    description: description || undefined,
    model: model && model !== config.agents.defaults.model ? model : undefined,
    systemPrompt: systemPrompt || undefined,
    sandbox: { allowedPermissions: permissions as SandboxPermission[] },
    peers: peers.length > 0 ? peers : undefined,
    acceptFrom: acceptFrom.length > 0 ? acceptFrom : undefined,
    channels: channels.length > 0 ? channels : undefined,
    channelRouting: channels.length > 0 ? channelRouting : undefined,
  };

  config.agents.registry[agentName] = entry;
  await saveConfig(config);

  success(`Agent "${agentName}" créé.`);
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

  // Remove from peers/acceptFrom of other agents
  for (const agent of Object.values(config.agents.registry)) {
    if (agent.peers) {
      agent.peers = agent.peers.filter((p) => p !== agentName);
    }
    if (agent.acceptFrom) {
      agent.acceptFrom = agent.acceptFrom.filter((p) => p !== agentName);
    }
  }

  await saveConfig(config);
  success(`Agent "${agentName}" supprimé (retiré des peers des autres agents).`);
}
