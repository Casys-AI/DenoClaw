import type { Config } from "../config/types.ts";
import type { AgentEntry } from "../shared/types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { getDeployOrgToken } from "../shared/deploy_credentials.ts";
import { deriveBrokerKvName } from "../shared/naming.ts";
import { ask, choose, confirm, error, print, success } from "./prompt.ts";
import { output } from "./output.ts";
import {
  buildDeployAssets,
  createDeployApiHeaders,
  createDeployEnvVars,
  deployAppRevision,
  ensureDeployApp,
  getDeployAppEndpoint,
  registerAgentEndpointWithBroker,
  resolveBrokerUrl,
  updateDeployAppConfig,
} from "./deploy_api.ts";

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

  const choice = await choose(
    "Which provider should be configured?",
    PROVIDER_OPTIONS,
  );
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

      success("Telegram configured. Start local dev mode:");
      print("  denoclaw dev");
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
      print("  denoclaw dev");
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

// ── publish agent app (Deploy API) ──────────────────────

export async function publishAgent(): Promise<void> {
  print("\n=== Publish an Agent App to Deno Deploy ===\n");

  const token = await ask("Deno Deploy organization access token");
  const agentName = await ask("Agent name", "denoclaw-agent-1");

  if (!token) {
    error("A Deno Deploy organization access token is required.");
    print(
      "  Create it from Settings > Access Tokens in the Deno Deploy dashboard",
    );
    return;
  }

  // Read local config for the model and sandbox permissions
  const config = await getConfigOrDefault();
  const model = config.agents.defaults.model;
  const sandboxPerms = config.agents.defaults.sandbox?.allowedPermissions ||
    ["read", "write", "run", "net"];
  const brokerUrl = resolveBrokerUrl(config) || await ask("Broker URL");
  const brokerOidcAudience = Deno.env.get("DENOCLAW_BROKER_OIDC_AUDIENCE") ||
    config.deploy?.oidcAudience ||
    brokerUrl;
  const brokerToken = Deno.env.get("DENOCLAW_API_TOKEN") ||
    await ask("Broker token (empty = rely on OIDC / unauthenticated broker)");

  print(`  Agent: ${agentName}`);
  print(`  Model: ${model}`);
  print(`  Sandbox permissions: ${sandboxPerms.join(", ")}`);
  print(`  Broker URL: ${brokerUrl}`);

  const headers = createDeployApiHeaders(token);

  try {
    print("\n1. Ensuring the Deploy app exists...");
    const app = await ensureDeployApp(agentName, headers);

    // 3. Create the deployment with the AgentRuntime code
    print("2. Deploying AgentRuntime...");

    const entry: AgentEntry = {
      model,
      sandbox: { allowedPermissions: sandboxPerms },
    };
    const entrypoint = generateAgentEntrypoint(agentName, entry);
    const assets = await buildDeployAssets(entrypoint);
    const envVars = createDeployEnvVars({
      DENOCLAW_AGENT_ID: agentName,
      DENOCLAW_BROKER_URL: brokerUrl,
      ...(brokerOidcAudience && brokerOidcAudience !== brokerUrl
        ? { DENOCLAW_BROKER_OIDC_AUDIENCE: brokerOidcAudience }
        : {}),
      ...(brokerToken ? { DENOCLAW_API_TOKEN: brokerToken } : {}),
    });

    const revision = await deployAppRevision({
      app,
      assets,
      envVars,
      headers,
    });
    const endpoint = getDeployAppEndpoint(app);

    success(`Agent deployed: ${revision.id}`);
    print(`  URL: ${endpoint}`);
    if (brokerToken) {
      await registerAgentEndpointWithBroker({
        brokerUrl,
        authToken: brokerToken,
        agentId: agentName,
        endpoint,
        config: entry,
      });
      print("  Broker registration: ok");
    }

    print(`
✓ Agent "${agentName}" published to Deno Deploy!

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
 * Generate the entrypoint code for a deployed agent app.
 * Uses the real AgentRuntime + BrokerClient from the DenoClaw SDK.
 */
export function generateAgentEntrypoint(
  agentId: string,
  entry: AgentEntry,
): string {
  return `// Auto-generated DenoClaw Agent Runtime
// Agent: ${agentId} | Model: ${entry.model ?? "unknown"}

import { startDeployedAgentRuntime } from "./src/agent/deploy_runtime.ts";

await startDeployedAgentRuntime({
  agentId: ${JSON.stringify(agentId)},
  entry: ${JSON.stringify(entry, null, 2)},
});
`;
}

// ── deploy broker (Deploy) ──────────────────────────────

export async function deployBroker(opts?: {
  org?: string;
  app?: string;
  region?: string;
  prod?: boolean;
}): Promise<void> {
  const config = await getConfigOrDefault();
  const deployToken = getDeployOrgToken() ??
    await ask("Deno Deploy organization access token");

  // 1. Determine org and app
  const org = opts?.org || config.deploy?.org ||
    await ask("Deploy org", config.deploy?.org || "casys");
  const app = opts?.app || config.deploy?.app ||
    await ask("Deploy app name", config.deploy?.app || "denoclaw");
  const region = opts?.region || config.deploy?.region || "global";
  const kvDatabase = config.deploy?.kvDatabase || deriveBrokerKvName(app);

  if (!org || !app) {
    error("Organization and app name are required. Use --org and --app.");
    return;
  }

  if (!deployToken) {
    error(
      "A Deno Deploy organization access token is required. Set DENO_DEPLOY_ORG_TOKEN.",
    );
    return;
  }

  const repoRoot = Deno.cwd();
  const cliEnv = {
    ...Deno.env.toObject(),
    DENO_DEPLOY_TOKEN: deployToken,
  };
  const decoder = new TextDecoder();
  const apiHeaders = createDeployApiHeaders(deployToken);
  const brokerAppConfig = {
    install: "true",
    build: "true",
    predeploy: "true",
    runtime: {
      type: "dynamic" as const,
      entrypoint: "./main.ts",
      args: ["broker"],
      cwd: ".",
    },
    crons: true,
  };

  async function runDeployCli(
    args: string[],
    opts?: { cwd?: string; echo?: boolean },
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const cmd = new Deno.Command("deno", {
      args,
      cwd: opts?.cwd,
      env: cliEnv,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    const stdout = decoder.decode(result.stdout).trim();
    const stderr = decoder.decode(result.stderr).trim();

    if (opts?.echo) {
      if (stdout) print(stdout);
      if (stderr) print(stderr);
    }

    return { success: result.success, stdout, stderr };
  }

  async function ensureBrokerApp(): Promise<boolean> {
    try {
      await updateDeployAppConfig({
        app,
        headers: apiHeaders,
        config: brokerAppConfig,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("(404)")) throw err;
    }

    print(`App ${app} not found. Creating...`);
    const createResult = await runDeployCli([
      "deploy",
      "create",
      "--no-wait",
      "--org",
      org,
      "--app",
      app,
      "--source",
      "local",
      "--app-directory",
      ".",
      "--do-not-use-detected-build-config",
      "--install-command",
      "true",
      "--build-command",
      "true",
      "--pre-deploy-command",
      "true",
      "--region",
      region,
      "--runtime-mode",
      "dynamic",
      "--entrypoint",
      "./main.ts",
      "--arguments",
      "broker",
      "--working-directory",
      ".",
    ], { cwd: repoRoot, echo: true });

    if (!createResult.success) {
      error("Failed to create app on Deno Deploy.");
      return false;
    }

    success(`App ${app} created on org ${org}`);
    await updateDeployAppConfig({
      app,
      headers: apiHeaders,
      config: brokerAppConfig,
    });
    return true;
  }

  if (!await ensureBrokerApp()) {
    return;
  }

  async function ensureBrokerKvDatabase(): Promise<void> {
    print(`Ensuring shared KV database ${kvDatabase}...`);

    const provisionResult = await runDeployCli(
      [
        "deploy",
        "database",
        "provision",
        kvDatabase,
        "--kind",
        "denokv",
        "--org",
        org,
      ],
      { cwd: "/tmp" },
    );

    if (!provisionResult.success) {
      const provisionOutput =
        `${provisionResult.stdout}\n${provisionResult.stderr}`;
      if (!provisionOutput.includes("The requested slug is already in use.")) {
        throw new Error(
          `failed to provision shared KV database ${kvDatabase}: ${provisionOutput.trim()}`
            .trim(),
        );
      }
    }

    const assignResult = await runDeployCli(
      [
        "deploy",
        "database",
        "assign",
        kvDatabase,
        "--org",
        org,
        "--app",
        app,
      ],
      { cwd: "/tmp" },
    );

    if (!assignResult.success) {
      const assignOutput = `${assignResult.stdout}\n${assignResult.stderr}`;
      if (
        !assignOutput.includes(
          "The app already has a Deno KV database assigned.",
        )
      ) {
        throw new Error(
          `failed to assign shared KV database ${kvDatabase}: ${assignOutput.trim()}`
            .trim(),
        );
      }
    }
  }

  await ensureBrokerKvDatabase();

  async function upsertDeployEnvVar(
    key: string,
    value: string,
  ): Promise<void> {
    const addResult = await runDeployCli(
      [
        "deploy",
        "env",
        "add",
        "--org",
        org,
        "--app",
        app,
        "--secret",
        key,
        value,
      ],
      { cwd: "/tmp" },
    );

    if (addResult.success) {
      return;
    }

    const combined = `${addResult.stdout}\n${addResult.stderr}`.toLowerCase();
    if (
      combined.includes("already exists") ||
      combined.includes("already been taken")
    ) {
      const updateResult = await runDeployCli(
        [
          "deploy",
          "env",
          "update-value",
          "--org",
          org,
          "--app",
          app,
          key,
          value,
        ],
        { cwd: "/tmp" },
      );

      if (updateResult.success) {
        return;
      }

      const body = `${updateResult.stdout}\n${updateResult.stderr}`.trim();
      throw new Error(`failed to update env var ${key}: ${body}`.trim());
    }

    const body = `${addResult.stdout}\n${addResult.stderr}`.trim();
    throw new Error(`failed to add env var ${key}: ${body}`.trim());
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
      await upsertDeployEnvVar(envMap[name], cfg.apiKey);
    }
  }

  // Ensure DENOCLAW_API_TOKEN is set
  let apiToken = Deno.env.get("DENOCLAW_API_TOKEN");
  if (!apiToken) {
    apiToken = crypto.randomUUID();
  }

  print("Setting DENOCLAW_API_TOKEN...");
  await upsertDeployEnvVar("DENOCLAW_API_TOKEN", apiToken);

  // 4. Deploy
  print("\nDeploying...");
  const deployArgs = ["deploy", repoRoot, "--org", org, "--app", app];
  if (opts?.prod !== false) deployArgs.push("--prod");
  const deployResult = await runDeployCli(deployArgs, { echo: true });

  if (!deployResult.success) {
    error("Deployment failed.");
    return;
  }

  const combinedOutput = `${deployResult.stdout}\n${deployResult.stderr}`;
  const deployedUrl = combinedOutput.match(
    /Production url:\s*\n\s*(https:\/\/\S+)/i,
  )?.[1] ?? `https://${app}.${org}.deno.net`;

  // 5. Save deploy config locally for future use
  config.deploy = {
    org,
    app,
    region,
    kvDatabase,
    url: deployedUrl,
  };
  await saveConfig(config);

  success(`Broker deployed to ${deployedUrl}`);
  print(`\n  API token: ${apiToken}`);
  print(
    `  Test: curl -H "Authorization: Bearer ${apiToken}" ${deployedUrl}/health`,
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
  if (deploy?.url) {
    const brokerUrl = deploy.url;
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
  } else if (deploy?.app) {
    print(`\n── Remote Broker ──\n`);
    print(`App          : ${deploy.app}`);
    print(
      `URL          : not configured (set deploy.url or DENOCLAW_BROKER_URL)`,
    );
  }

  print("");

  output({
    providers,
    model: config.agents.defaults.model,
    channels,
    deploy: deploy ?? null,
  });
}
