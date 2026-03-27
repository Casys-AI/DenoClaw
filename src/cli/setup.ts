import type { Config } from "../config/types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { ask, choose, confirm, error, print, success } from "./prompt.ts";

// ── setup provider ──────────────────────────────────────

const PROVIDER_OPTIONS = [
  "anthropic  — Claude (API key)",
  "openai     — GPT (API key)",
  "ollama     — Ollama Cloud (API key)",
  "claude-cli — Claude Code CLI (local auth)",
  "codex-cli  — Codex CLI (local auth)",
  "openrouter — Multi-model gateway (API key)",
  "deepseek   — DeepSeek (API key)",
  "groq       — Groq (API key)",
  "gemini     — Google Gemini (API key)",
];

const NO_KEY_PROVIDERS = new Set(["claude-cli", "codex-cli"]);

export async function setupProvider(): Promise<void> {
  const config = await getConfigOrDefault();

  const choice = await choose("Quel provider configurer ?", PROVIDER_OPTIONS);
  const providerName = choice.split("—")[0].trim().split(/\s+/)[0];

  if (NO_KEY_PROVIDERS.has(providerName)) {
    if (providerName === "claude-cli" || providerName === "codex-cli") {
      const binary = providerName.replace("-cli", "");

      // Vérifier si le CLI est installé
      try {
        const check = new Deno.Command("which", { args: [binary], stdout: "piped", stderr: "piped" });
        const { success: found } = await check.output();
        if (!found) throw new Error("not found");
        success(`${binary} CLI détecté`);
      } catch {
        error(`${binary} CLI non trouvé.`);
        print(`  Installez-le : https://${binary === "claude" ? "claude.ai/download" : "openai.com/codex"}`);
        return;
      }

      // Vérifier si déjà authentifié
      print(`\nVérification de l'auth ${binary}...`);
      const authCheck = new Deno.Command(binary, {
        args: binary === "claude" ? ["auth", "status"] : ["auth", "whoami"],
        stdout: "piped",
        stderr: "piped",
      });
      const { success: authed } = await authCheck.output();

      if (authed) {
        success(`${binary} CLI déjà authentifié`);
      } else {
        // Lancer le flux OAuth navigateur
        print(`\nLancement de l'authentification ${binary} (ouverture du navigateur)...\n`);
        const authCmd = new Deno.Command(binary, {
          args: ["auth", "login"],
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        });
        const { success: loginOk } = await authCmd.output();

        if (loginOk) {
          success(`${binary} CLI authentifié`);
        } else {
          error(`Échec de l'auth ${binary}. Réessayez manuellement : ${binary} auth login`);
          return;
        }
      }

      config.providers[providerName] = { enabled: true };
      print(`\n  denoclaw agent --model ${providerName}`);

    } else {
      config.providers[providerName] = { enabled: true };
      print(`  denoclaw agent --model ${providerName}`);
    }
  } else {
    const key = await ask(`Clé API ${providerName}`);
    if (!key) {
      error("Clé vide, annulé.");
      return;
    }
    config.providers[providerName] = { apiKey: key, enabled: true };
  }

  // Set as default model?
  if (await confirm(`Définir ${providerName} comme provider par défaut ?`)) {
    const model = await ask("Modèle par défaut", getDefaultModel(providerName));
    config.agents.defaults.model = model;
  }

  await saveConfig(config);
  success(`Provider ${providerName} configuré.`);
}

function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    anthropic: "anthropic/claude-sonnet-4-6",
    openai: "openai/gpt-4o",
    ollama: "ollama/nemotron-3-super",
    "claude-cli": "claude-cli",
    "codex-cli": "codex-cli",
    openrouter: "openrouter/anthropic/claude-sonnet-4-6",
    deepseek: "deepseek/deepseek-chat",
    groq: "groq/llama-3.3-70b-versatile",
    gemini: "gemini/gemini-2.0-flash",
  };
  return defaults[provider] || provider;
}

// ── setup channel ───────────────────────────────────────

export async function setupChannel(): Promise<void> {
  const config = await getConfigOrDefault();

  const choice = await choose("Quel channel configurer ?", [
    "telegram  — Bot Telegram",
    "webhook   — Webhook HTTP générique",
  ]);
  const channelName = choice.split("—")[0].trim().split(/\s+/)[0];

  switch (channelName) {
    case "telegram": {
      const token = await ask("Token du bot Telegram (depuis @BotFather)");
      if (!token) {
        error("Token vide, annulé.");
        return;
      }

      const allowFrom = await ask("User IDs autorisés (virgule séparés, vide = tous)");
      config.channels.telegram = {
        enabled: true,
        token,
        allowFrom: allowFrom ? allowFrom.split(",").map((s) => s.trim()) : undefined,
      };

      success("Telegram configuré. Lancez le gateway :");
      print("  denoclaw gateway");
      break;
    }

    case "webhook": {
      const port = parseInt(await ask("Port", "8787"));
      const secret = await ask("Secret (header Authorization, vide = pas de secret)");
      config.channels.webhook = {
        enabled: true,
        port: port || 8787,
        secret: secret || undefined,
      };

      success(`Webhook configuré sur port ${port || 8787}.`);
      print("  denoclaw gateway");
      break;
    }
  }

  await saveConfig(config);
}

// ── setup agent ─────────────────────────────────────────

export async function setupAgent(): Promise<void> {
  const config = await getConfigOrDefault();

  print("\n=== Configuration de l'agent ===");

  const model = await ask("Modèle LLM", config.agents.defaults.model);
  config.agents.defaults.model = model;

  const temp = parseFloat(await ask("Température", String(config.agents.defaults.temperature)));
  if (!isNaN(temp)) config.agents.defaults.temperature = temp;

  const tokens = parseInt(await ask("Max tokens", String(config.agents.defaults.maxTokens)));
  if (!isNaN(tokens)) config.agents.defaults.maxTokens = tokens;

  const customPrompt = await ask("System prompt custom (vide = défaut)");
  if (customPrompt) config.agents.defaults.systemPrompt = customPrompt;

  if (await confirm("Restreindre les commandes shell au workspace ?", false)) {
    config.tools.restrictToWorkspace = true;
  }

  await saveConfig(config);
  success("Agent configuré.");
  print("  denoclaw agent       — chat interactif");
  print("  denoclaw agent -m .. — message unique");
}

// ── publish agent (Subhosting) ──────────────────────────

export async function publishAgent(): Promise<void> {
  print("\n=== Publier un agent sur Deno Subhosting ===\n");

  const orgId = await ask("Organization ID Subhosting");
  const token = await ask("Access token Subhosting");
  const agentName = await ask("Nom de l'agent", "denoclaw-agent-1");

  if (!orgId || !token) {
    error("Organization ID et token requis.");
    print("  Créez-les sur https://dash.deno.com/subhosting");
    return;
  }

  // Lire config locale pour le modèle et les permissions sandbox
  const config = await getConfigOrDefault();
  const model = config.agents.defaults.model;
  const sandboxPerms = config.agents.defaults.sandbox?.allowedPermissions || ["read", "write", "run", "net"];

  print(`  Agent: ${agentName}`);
  print(`  Modèle: ${model}`);
  print(`  Sandbox permissions: ${sandboxPerms.join(", ")}`);

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const apiBase = "https://api.deno.com/v1";

  try {
    // 1. Créer le projet
    print("\n1. Création du projet Subhosting...");
    const projRes = await fetch(`${apiBase}/organizations/${orgId}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: agentName }),
    });

    if (!projRes.ok && (await projRes.text()).includes("already exists")) {
      print("   Projet existe déjà, on continue.");
    } else if (!projRes.ok) {
      error(`Échec création projet : ${projRes.status}`);
      return;
    } else {
      const project = await projRes.json() as { id: string };
      success(`Projet créé : ${project.id}`);
    }

    // 2. Lister les projets pour trouver l'ID
    const listRes = await fetch(`${apiBase}/organizations/${orgId}/projects`, { headers });
    const projects = await listRes.json() as { id: string; name: string }[];
    const project = projects.find((p) => p.name === agentName);
    if (!project) {
      error("Projet introuvable après création");
      return;
    }

    // 3. Créer le deployment avec le code de l'AgentRuntime
    print("2. Déploiement de l'AgentRuntime...");

    const entrypoint = generateAgentEntrypoint(agentName, model, sandboxPerms);

    const deployRes = await fetch(`${apiBase}/projects/${project.id}/deployments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entryPointUrl: "main.ts",
        assets: {
          "main.ts": { kind: "file", content: entrypoint, encoding: "utf-8" },
        },
        envVars: {
          DENOCLAW_AGENT_ID: agentName,
          DENOCLAW_MODEL: model,
        },
      }),
    });

    if (!deployRes.ok) {
      const body = await deployRes.text();
      error(`Échec déploiement : ${deployRes.status} ${body}`);
      return;
    }

    const deployment = await deployRes.json() as { id: string; domainMappings?: { domain: string }[] };
    const domain = deployment.domainMappings?.[0]?.domain;

    success(`Agent déployé : ${deployment.id}`);
    if (domain) print(`  URL : https://${domain}`);

    print(`
✓ Agent "${agentName}" publié sur Subhosting !

  L'agent écoute les messages via KV Queues.
  Il communique avec le broker pour les LLM calls et tool execution.

  Pour envoyer un message à cet agent :
    Depuis un autre agent : broker.sendToAgent("${agentName}", "instruction")
    Depuis le broker : route un message avec to="${agentName}"
`);
  } catch (e) {
    error(`Erreur : ${(e as Error).message}`);
  }
}

/**
 * Génère le code entrypoint pour un agent Subhosting.
 * C'est un AgentRuntime minimal qui écoute KV Queues.
 */
function generateAgentEntrypoint(agentId: string, model: string, permissions: string[]): string {
  return `// Auto-generated DenoClaw Agent Runtime
// Agent: ${agentId} | Model: ${model}

const kv = await Deno.openKv();
const agentId = Deno.env.get("DENOCLAW_AGENT_ID") || "${agentId}";
const model = Deno.env.get("DENOCLAW_MODEL") || "${model}";

console.log("Agent started:", agentId, "model:", model);

// Register agent status
await kv.set(["agents", agentId, "status"], {
  status: "running",
  startedAt: new Date().toISOString(),
  model,
  sandboxPermissions: ${JSON.stringify(permissions)},
});

// Store agent config for broker permission checks
await kv.set(["agents", agentId, "config"], {
  model,
  sandbox: { allowedPermissions: ${JSON.stringify(permissions)} },
});

// Listen for messages via KV Queue
kv.listenQueue(async (raw) => {
  const msg = raw;
  if (msg.to !== agentId) return;

  console.log("Message received:", msg.type, "from:", msg.from);

  if (msg.type === "agent_message") {
    const payload = msg.payload;

    // Load conversation history
    const historyEntry = await kv.get(["memory", agentId, msg.from]);
    const history = historyEntry.value || [];
    history.push({ role: "user", content: payload.instruction });

    // Request LLM completion via broker
    const llmRequestId = crypto.randomUUID();
    await kv.enqueue({
      id: llmRequestId,
      from: agentId,
      to: "broker",
      type: "llm_request",
      payload: { messages: [{ role: "system", content: "You are a helpful agent." }, ...history], model },
      timestamp: new Date().toISOString(),
    });

    // Note: response comes back via KV Queue as llm_response
    // A full implementation would use a promise-based request/response pattern
    // (see BrokerClient in the full DenoClaw SDK)
  }
});

// Heartbeat
Deno.cron("heartbeat", "*/5 * * * *", async () => {
  await kv.set(["agents", agentId, "status"], {
    status: "alive",
    lastHeartbeat: new Date().toISOString(),
    model,
  });
});

// Keep alive
Deno.serve({ port: 8000 }, () => new Response("DenoClaw Agent: " + agentId));
`;
}

// ── publish gateway (Deploy) ────────────────────────────

export async function publishGateway(): Promise<void> {
  print("\n=== Déployer le gateway sur Deno Deploy ===\n");

  try {
    const cmd = new Deno.Command("deployctl", { args: ["--version"], stdout: "piped", stderr: "piped" });
    const { success: ok } = await cmd.output();
    if (!ok) throw new Error("not found");
  } catch {
    error("deployctl non installé.");
    print("  deno install -Arf jsr:@deno/deployctl");
    return;
  }

  const projectName = await ask("Nom du projet Deploy", "denoclaw-gateway");

  // Lire la config locale pour récupérer les clés existantes
  const config = await getConfigOrDefault();
  const localKeys: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(config.providers)) {
    if (cfg?.apiKey) localKeys[name] = cfg.apiKey;
  }

  // Générer un token API pour le gateway
  const apiToken = crypto.randomUUID();
  const envArgs = [`--env=DENOCLAW_API_TOKEN=${apiToken}`];

  if (Object.keys(localKeys).length > 0) {
    print(`\nClés API trouvées dans la config locale : ${Object.keys(localKeys).join(", ")}`);
    if (await confirm("Utiliser ces clés pour le déploiement ?")) {
      const envMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        ollama: "OLLAMA_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
        groq: "GROQ_API_KEY",
        gemini: "GEMINI_API_KEY",
      };
      for (const [name, key] of Object.entries(localKeys)) {
        const envName = envMap[name];
        if (envName) envArgs.push(`--env=${envName}=${key}`);
      }
      success("Clés locales récupérées");
    }
  } else {
    print("\nAucune clé dans la config locale. Saisie manuelle :");
    const anthropicKey = await ask("ANTHROPIC_API_KEY (vide = skip)");
    const openaiKey = await ask("OPENAI_API_KEY (vide = skip)");
    if (anthropicKey) envArgs.push(`--env=ANTHROPIC_API_KEY=${anthropicKey}`);
    if (openaiKey) envArgs.push(`--env=OPENAI_API_KEY=${openaiKey}`);
  }

  // Modèle par défaut
  envArgs.push(`--env=DENOCLAW_DEFAULT_MODEL=${config.agents.defaults.model}`);

  if (await confirm("\nDéployer ?")) {

    print("\nDéploiement en cours...");
    const cmd = new Deno.Command("deployctl", {
      args: ["deploy", `--project=${projectName}`, "--prod", ...envArgs, "main.ts"],
      stdout: "inherit",
      stderr: "inherit",
    });

    const { success: ok } = await cmd.output();
    if (ok) {
      success(`Gateway déployé sur https://${projectName}.deno.dev`);
      print(`\n  Token API : ${apiToken}`);
      print(`  Gardez-le — c'est la clé d'accès au gateway.\n`);
      print("  Test :");
      print(`    curl -H "Authorization: Bearer ${apiToken}" https://${projectName}.deno.dev/health`);
      print("\n  Pour plus de sécurité (zéro secret statique) :");
      print("  → Configurer GCP OIDC + Secret Manager (voir ADR-004)");
      print(`  → deno deploy setup-gcp --org=<org> --app=${projectName}`);
    } else {
      error("Échec du déploiement.");
    }
  }
}

// ── status amélioré ─────────────────────────────────────

export async function showStatus(config: Config): Promise<void> {
  print("\n=== DenoClaw Status ===\n");

  // Providers
  const providers = Object.entries(config.providers)
    .filter(([_, v]) => v?.apiKey || v?.enabled)
    .map(([k, v]) => `${k}${v?.apiKey ? " (key)" : " (no-key)"}`);

  print(`Providers    : ${providers.join(", ") || "aucun"}`);
  print(`Modèle       : ${config.agents.defaults.model}`);
  print(`Température  : ${config.agents.defaults.temperature}`);
  print(`Max tokens   : ${config.agents.defaults.maxTokens}`);

  // Channels
  const channels = Object.entries(config.channels)
    .filter(([_, v]) => v && "enabled" in v && v.enabled)
    .map(([k]) => k);
  print(`Channels     : ${channels.join(", ") || "aucun"}`);

  // Tools
  print(`Workspace    : ${config.tools.restrictToWorkspace ? "restreint" : "libre"}`);

  // Sessions (KV)
  try {
    const { SessionManager } = await import("../messaging/session.ts");
    const sm = new SessionManager();
    const sessions = await sm.getActive();
    print(`Sessions     : ${sessions.length} active(s)`);
    sm.close();
  } catch {
    print(`Sessions     : KV non disponible`);
  }

  print("");
}
