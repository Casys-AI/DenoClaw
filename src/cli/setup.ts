import type { Config } from "../config/types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { ask, choose, confirm, error, print, success } from "./prompt.ts";
import { output } from "./output.ts";

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

  const choice = await choose("Which provider should be configured?", PROVIDER_OPTIONS);
  const providerName = choice.split("—")[0].trim().split(/\s+/)[0];

  if (NO_KEY_PROVIDERS.has(providerName)) {
    if (providerName === "claude-cli" || providerName === "codex-cli") {
      const binary = providerName.replace("-cli", "");

      // Check whether the CLI is installed
      const check = new Deno.Command("which", {
        args: [binary],
        stdout: "piped",
        stderr: "piped",
      });
      const { success: found } = await check.output();
      if (!found) {
        error(`${binary} CLI not found.`);
        print(
          `  Install it: https://${
            binary === "claude" ? "claude.ai/download" : "openai.com/codex"
          }`,
        );
        return;
      }
      success(`${binary} CLI detected`);

      // Check whether it is already authenticated
      print(`\nChecking ${binary} authentication...`);
      const authCheck = new Deno.Command(binary, {
        args: binary === "claude" ? ["auth", "status"] : ["auth", "whoami"],
        stdout: "piped",
        stderr: "piped",
      });
      const { success: authed } = await authCheck.output();

      if (authed) {
        success(`${binary} CLI already authenticated`);
      } else {
        // Start the browser-based OAuth flow
        print(
          `\nStarting ${binary} authentication (opening browser)...\n`,
        );
        const authCmd = new Deno.Command(binary, {
          args: ["auth", "login"],
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        });
        const { success: loginOk } = await authCmd.output();

        if (loginOk) {
          success(`${binary} CLI authenticated`);
        } else {
          error(
            `Failed to authenticate ${binary}. Retry manually: ${binary} auth login`,
          );
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
    const key = await ask(`${providerName} API key`);
    if (!key) {
      error("Empty key, canceled.");
      return;
    }
    config.providers[providerName] = { apiKey: key, enabled: true };
  }

  // Set as default model?
  if (await confirm(`Set ${providerName} as the default provider?`)) {
    const model = await ask("Default model", getDefaultModel(providerName));
    config.agents.defaults.model = model;
  }

  await saveConfig(config);
  success(`Provider ${providerName} configured.`);
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

  const choice = await choose("Which channel should be configured?", [
    "telegram  — Bot Telegram",
    "webhook   — Generic HTTP webhook",
  ]);
  const channelName = choice.split("—")[0].trim().split(/\s+/)[0];

  switch (channelName) {
    case "telegram": {
      const token = await ask("Telegram bot token (from @BotFather)");
      if (!token) {
        error("Empty token, canceled.");
        return;
      }

      const allowFrom = await ask(
        "Allowed user IDs (comma-separated, empty = all)",
      );
      config.channels.telegram = {
        enabled: true,
        token,
        allowFrom: allowFrom
          ? allowFrom.split(",").map((s) => s.trim())
          : undefined,
      };

      success("Telegram configured. Start the gateway:");
      print("  denoclaw gateway");
      break;
    }

    case "webhook": {
      const port = parseInt(await ask("Port", "8787"));
      const secret = await ask(
        "Secret (Authorization header, empty = no secret)",
      );
      config.channels.webhook = {
        enabled: true,
        port: port || 8787,
        secret: secret || undefined,
      };

      success(`Webhook configured on port ${port || 8787}.`);
      print("  denoclaw gateway");
      break;
    }
  }

  await saveConfig(config);
}

// ── setup agent ─────────────────────────────────────────

export async function setupAgent(): Promise<void> {
  const config = await getConfigOrDefault();

  print("\n=== Agent Configuration ===");

  const model = await ask("LLM model", config.agents.defaults.model);
  config.agents.defaults.model = model;

  const temp = parseFloat(
    await ask("Temperature", String(config.agents.defaults.temperature)),
  );
  if (!isNaN(temp)) config.agents.defaults.temperature = temp;

  const tokens = parseInt(
    await ask("Max tokens", String(config.agents.defaults.maxTokens)),
  );
  if (!isNaN(tokens)) config.agents.defaults.maxTokens = tokens;

  const customPrompt = await ask("Custom system prompt (empty = default)");
  if (customPrompt) config.agents.defaults.systemPrompt = customPrompt;

  if (await confirm("Restrict shell commands to the workspace?", false)) {
    config.tools.restrictToWorkspace = true;
  }

  await saveConfig(config);
  success("Agent configured.");
  print("  denoclaw agent       — interactive chat");
  print("  denoclaw agent -m .. — one-off message");
}

// ── publish agent (Subhosting) ──────────────────────────

export async function publishAgent(): Promise<void> {
  print("\n=== Publish an Agent to Deno Subhosting ===\n");

  const orgId = await ask("Organization ID Subhosting");
  const token = await ask("Access token Subhosting");
  const agentName = await ask("Agent name", "denoclaw-agent-1");

  if (!orgId || !token) {
    error("Organization ID and token are required.");
    print("  Create them at https://dash.deno.com/subhosting");
    return;
  }

  // Read local config for the model and sandbox permissions
  const config = await getConfigOrDefault();
  const model = config.agents.defaults.model;
  const sandboxPerms = config.agents.defaults.sandbox?.allowedPermissions ||
    ["read", "write", "run", "net"];

  print(`  Agent: ${agentName}`);
  print(`  Model: ${model}`);
  print(`  Sandbox permissions: ${sandboxPerms.join(", ")}`);

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const apiBase = "https://api.deno.com/v2";

  try {
    // 1. Create the project
    print("\n1. Creating the Subhosting project...");
    const projRes = await fetch(`${apiBase}/organizations/${orgId}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: agentName }),
    });

    if (!projRes.ok && (await projRes.text()).includes("already exists")) {
      print("   Project already exists, continuing.");
    } else if (!projRes.ok) {
      error(`Project creation failed: ${projRes.status}`);
      return;
    } else {
      const project = await projRes.json() as { id: string };
      success(`Project created: ${project.id}`);
    }

    // 2. List projects to find the ID
    const listRes = await fetch(`${apiBase}/organizations/${orgId}/projects`, {
      headers,
    });
    const projects = await listRes.json() as { id: string; name: string }[];
    const project = projects.find((p) => p.name === agentName);
    if (!project) {
      error("Project not found after creation");
      return;
    }

    // 3. Create the deployment with the AgentRuntime code
    print("2. Deploying AgentRuntime...");

    const entrypoint = generateAgentEntrypoint(agentName, model, sandboxPerms);

    const deployRes = await fetch(
      `${apiBase}/projects/${project.id}/deployments`,
      {
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
      },
    );

    if (!deployRes.ok) {
      const body = await deployRes.text();
      error(`Deployment failed: ${deployRes.status} ${body}`);
      return;
    }

    const deployment = await deployRes.json() as {
      id: string;
      domainMappings?: { domain: string }[];
    };
    const domain = deployment.domainMappings?.[0]?.domain;

    success(`Agent deployed: ${deployment.id}`);
    if (domain) print(`  URL: https://${domain}`);

    print(`
✓ Agent "${agentName}" published to Subhosting!

  The agent exposes a broker-driven runtime.
  It talks to the broker for LLM calls, tool execution, and durable persistence.

  To send a message to this agent:
    From another agent: broker.sendTextTask("${agentName}", "instruction")
    From the broker: route a task_submit with targetAgent="${agentName}"
`);
  } catch (e) {
    error(`Error: ${(e as Error).message}`);
  }
}

/**
 * Generate the entrypoint code for a Subhosting agent.
 * Uses the real AgentRuntime + BrokerClient from the DenoClaw SDK.
 */
export function generateAgentEntrypoint(
  agentId: string,
  model: string,
  permissions: string[],
): string {
  return `// Auto-generated DenoClaw Agent Runtime
// Agent: ${agentId} | Model: ${model}

import { AgentRuntime } from "@denoclaw/denoclaw";
import { BrokerClient } from "@denoclaw/denoclaw";

const agentId = Deno.env.get("DENOCLAW_AGENT_ID") || "${agentId}";
const model = Deno.env.get("DENOCLAW_MODEL") || "${model}";

// Store agent config for broker permission checks
const kv = await Deno.openKv();
await kv.set(["agents", agentId, "config"], {
  model,
  sandbox: { allowedPermissions: ${JSON.stringify(permissions)} },
});
kv.close();

// Create the runtime with a real BrokerClient (implements both runtime ports)
const broker = new BrokerClient(agentId);
const runtime = new AgentRuntime(agentId, { model }, broker, broker);

await runtime.start();
await runtime.startKvQueueIntake();
console.log("Agent started:", agentId, "model:", model);

// Graceful shutdown
const ac = new AbortController();
Deno.addSignalListener("SIGINT", () => ac.abort());
Deno.addSignalListener("SIGTERM", () => ac.abort());

// Keep alive
Deno.serve({ port: 8000, signal: ac.signal }, () => new Response("DenoClaw Agent: " + agentId));

ac.signal.addEventListener("abort", async () => {
  await runtime.stop();
  console.log("Agent stopped:", agentId);
});
`;
}

// ── deploy broker (Deploy) ──────────────────────────────

export async function deployBroker(opts?: {
  org?: string;
  app?: string;
  prod?: boolean;
}): Promise<void> {
  const config = await getConfigOrDefault();

  // 1. Determine org and app
  const org = opts?.org || config.deploy?.org ||
    await ask("Deploy org", config.deploy?.org || "casys");
  const app = opts?.app || config.deploy?.app ||
    await ask("Deploy app name", config.deploy?.app || "denoclaw");

  if (!org || !app) {
    error("Organization and app name are required. Use --org and --app.");
    return;
  }

  // 2. Check if app exists, create if needed
  print(`\nChecking app ${app} on org ${org}...`);
  const checkCmd = new Deno.Command("deno", {
    args: ["deploy", "logs", "--org", org, "--app", app, "--limit", "1"],
    stdout: "piped",
    stderr: "piped",
  });
  const checkResult = await checkCmd.output();

  if (!checkResult.success) {
    print("App not found. Creating...");
    const createCmd = new Deno.Command("deno", {
      args: ["deploy", "create", "--org", org, "--app", app],
      stdout: "inherit",
      stderr: "inherit",
    });
    const createResult = await createCmd.output();
    if (!createResult.success) {
      error("Failed to create app on Deno Deploy.");
      return;
    }
    success(`App ${app} created on org ${org}`);
  } else {
    print(`App ${app} exists.`);
  }

  // 3. Sync env vars (LLM keys from local config)
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    ollama: "OLLAMA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: "GEMINI_API_KEY",
  };

  for (const [name, cfg] of Object.entries(config.providers)) {
    if (cfg?.apiKey && envMap[name]) {
      print(`Setting ${envMap[name]}...`);
      const envCmd = new Deno.Command("deno", {
        args: [
          "deploy",
          "env",
          "add",
          "--org",
          org,
          "--app",
          app,
          `${envMap[name]}=${cfg.apiKey}`,
        ],
        stdout: "piped",
        stderr: "piped",
      });
      await envCmd.output();
    }
  }

  // Ensure DENOCLAW_API_TOKEN is set
  let apiToken = Deno.env.get("DENOCLAW_API_TOKEN");
  if (!apiToken) {
    apiToken = crypto.randomUUID();
    print("Setting DENOCLAW_API_TOKEN...");
    const tokenCmd = new Deno.Command("deno", {
      args: [
        "deploy",
        "env",
        "add",
        "--org",
        org,
        "--app",
        app,
        `DENOCLAW_API_TOKEN=${apiToken}`,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    await tokenCmd.output();
  }

  // 4. Deploy
  print("\nDeploying...");
  const deployArgs = ["deploy", "--org", org, "--app", app];
  if (opts?.prod !== false) deployArgs.push("--prod");

  const deployCmd = new Deno.Command("deno", {
    args: deployArgs,
    stdout: "inherit",
    stderr: "inherit",
  });
  const deployResult = await deployCmd.output();

  if (!deployResult.success) {
    error("Deployment failed.");
    return;
  }

  // 5. Save deploy config locally for future use
  config.deploy = { org, app };
  await saveConfig(config);

  const url = `https://${app}.deno.dev`;
  success(`Broker deployed to ${url}`);
  print(`\n  API token: ${apiToken}`);
  print(
    `  Test: curl -H "Authorization: Bearer ${apiToken}" ${url}/health`,
  );
}

/** @deprecated Use deployBroker instead */
export async function publishGateway(): Promise<void> {
  await deployBroker();
}

// ── enhanced status ─────────────────────────────────────

export async function showStatus(config: Config): Promise<void> {
  print("\n=== DenoClaw Status ===\n");

  // Providers
  const providers = Object.entries(config.providers)
    .filter(([_, v]) => v?.apiKey || v?.enabled)
    .map(([k, v]) => `${k}${v?.apiKey ? " (key)" : " (no-key)"}`);

  print(`Providers    : ${providers.join(", ") || "none"}`);
  print(`Model        : ${config.agents.defaults.model}`);
  print(`Temperature  : ${config.agents.defaults.temperature}`);
  print(`Max tokens   : ${config.agents.defaults.maxTokens}`);

  // Channels
  const channels = Object.entries(config.channels)
    .filter(([_, v]) => v && "enabled" in v && v.enabled)
    .map(([k]) => k);
  print(`Channels     : ${channels.join(", ") || "none"}`);

  // Tools
  print(
    `Workspace    : ${
      config.tools.restrictToWorkspace ? "restricted" : "unrestricted"
    }`,
  );

  // Sessions (KV)
  try {
    const { SessionManager } = await import("../messaging/session.ts");
    const sm = new SessionManager();
    const sessions = await sm.getActive();
    print(`Sessions     : ${sessions.length} active(s)`);
    sm.close();
  } catch {
    print(`Sessions     : KV unavailable`);
  }

  // Remote broker status
  const deploy = config.deploy;
  if (deploy?.app) {
    const brokerUrl = `https://${deploy.app}.deno.dev`;
    const token = Deno.env.get("DENOCLAW_API_TOKEN");
    print(`\n── Remote Broker ──\n`);
    print(`URL          : ${brokerUrl}`);

    if (token) {
      try {
        const res = await fetch(`${brokerUrl}/health`, {
          headers: { "Authorization": `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const health = await res.json() as { tunnelCount?: number };
          print(`Status       : online`);
          print(`Tunnels      : ${health.tunnelCount ?? 0}`);
        } else {
          print(`Status       : error (${res.status})`);
        }
      } catch {
        print(`Status       : unreachable`);
      }
    } else {
      print(`Status       : no token (set DENOCLAW_API_TOKEN)`);
    }
  }

  print("");

  output({
    providers,
    model: config.agents.defaults.model,
    channels,
    deploy: deploy ?? null,
  });
}
