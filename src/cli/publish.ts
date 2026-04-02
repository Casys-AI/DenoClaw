import type { AgentEntry } from "../shared/types.ts";
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";
import { getDeployOrgToken } from "../shared/deploy_credentials.ts";
import { ask, confirm, error, print, success } from "./prompt.ts";
import { cliFlags, output, outputError } from "./output.ts";
import {
  createBrokerOwnedAgentConfig,
  generateAgentEntrypoint,
  materializePublishedEntry,
} from "./publish_entry.ts";
import { ensureAgentKvDatabase as ensureAgentKvDatabaseAssignment } from "./publish_kv.ts";
import { buildPublishedWorkspaceSnapshot } from "./publish_workspace.ts";
import {
  buildDeployAssets,
  createDeployApiHeaders,
  createDeployEnvVars,
  deployAppRevision,
  ensureDeployApp,
  getDeployAppEndpoint,
  registerAgentEndpointWithBroker,
  resolveBrokerUrl,
} from "./deploy_api.ts";

export interface PublishAgentsOptions {
  force?: boolean;
}

export async function publishDeprecatedAgent(
  agentName?: string,
  options: PublishAgentsOptions = {},
): Promise<void> {
  const resolvedAgentName = agentName ||
    (cliFlags().interactive ? await ask("Agent name") : undefined);

  if (!resolvedAgentName) {
    outputError(
      "AGENT_NAME_REQUIRED",
      "Agent name is required. Use 'denoclaw publish <agent>'.",
    );
    return;
  }

  await publishAgents(resolvedAgentName, options);
}

/**
 * Publish one or all agents to Deno Deploy v2 apps/revisions.
 * Each agent gets its own Deploy app + revision.
 */
export async function publishAgents(
  agentName?: string,
  options: PublishAgentsOptions = {},
): Promise<void> {
  const config = await getConfigOrDefault();
  const interactive = cliFlags().interactive;
  const deployOrg = config.deploy?.org ||
    (interactive
      ? await ask("Deno Deploy org", config.deploy?.org || "")
      : undefined);
  const resolvedBrokerUrl = resolveBrokerUrl(config);
  const brokerUrl = resolvedBrokerUrl ||
    (interactive
      ? await ask("Broker URL", resolvedBrokerUrl || "")
      : undefined);
  const brokerOidcAudience = Deno.env.get("DENOCLAW_BROKER_OIDC_AUDIENCE") ||
    config.deploy?.oidcAudience ||
    brokerUrl;
  const brokerToken = Deno.env.get("DENOCLAW_API_TOKEN") ||
    (interactive
      ? await ask(
        "Broker API token (empty = rely on OIDC / unauthenticated broker)",
      )
      : undefined);

  if (!brokerUrl) {
    outputError(
      "MISSING_BROKER_URL",
      "A broker URL is required. Set DENOCLAW_BROKER_URL or configure deploy.url.",
    );
    return;
  }

  if (!deployOrg) {
    outputError(
      "MISSING_DEPLOY_ORG",
      "A Deno Deploy org is required. Run broker deploy first or set deploy.org.",
    );
    return;
  }
  const resolvedDeployOrg = deployOrg;

  print(`Publishing Deno Deploy agent apps against broker ${brokerUrl}`);

  const token = getDeployOrgToken() ||
    (interactive
      ? await ask("Deno Deploy organization access token")
      : undefined);

  if (!token) {
    outputError(
      "MISSING_CREDENTIALS",
      "A Deno Deploy organization access token is required. Set DENO_DEPLOY_ORG_TOKEN, or pass it interactively.",
    );
    return;
  }

  const wsRegistry: Record<string, AgentEntry> = await WorkspaceLoader
    .buildRegistry();
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
      `Found ${agentsToPublish.length} agent(s): ${
        agentsToPublish.map(([n]) => n).join(", ")
      }`,
    );
    if (!options.force && !await confirm("Publish all to Deno Deploy?")) return;
  }

  const headers = createDeployApiHeaders(token);
  const cliEnv = {
    ...Deno.env.toObject(),
    DENO_DEPLOY_TOKEN: token,
  };

  async function runDeployCli(
    args: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const cmd = new Deno.Command("deno", {
      args,
      cwd: "/tmp",
      env: cliEnv,
      stdout: "piped",
      stderr: "piped",
    });
    const decoder = new TextDecoder();
    const result = await cmd.output();
    return {
      success: result.success,
      stdout: decoder.decode(result.stdout).trim(),
      stderr: decoder.decode(result.stderr).trim(),
    };
  }

  const results: {
    id: string;
    ok: boolean;
    domain?: string;
    error?: string;
  }[] = [];

  for (const [id, entry] of agentsToPublish) {
    print(`\n── Publishing ${id} ──`);

    const resolvedEntry = materializePublishedEntry(
      entry,
      config.agents.defaults,
    );
    const model = resolvedEntry.model!;
    const perms = resolvedEntry.sandbox?.allowedPermissions ||
      ["read", "write", "run"];

    let app;
    try {
      app = await ensureDeployApp(id, headers);
    } catch (appError) {
      const message = appError instanceof Error
        ? appError.message
        : String(appError);
      error(`${id}: failed to create/find deploy app (${message})`);
      results.push({ id, ok: false, error: message });
      continue;
    }

    try {
      await ensureAgentKvDatabaseAssignment({
        agentId: id,
        appSlug: app.slug,
        deployOrg: resolvedDeployOrg,
        brokerKvDatabase: config.deploy?.kvDatabase,
        runDeployCli,
      });
    } catch (kvError) {
      const message = kvError instanceof Error
        ? kvError.message
        : String(kvError);
      error(`${id}: failed to ensure agent KV (${message})`);
      results.push({ id, ok: false, error: message });
      continue;
    }

    let workspaceSnapshot;
    try {
      workspaceSnapshot = await buildPublishedWorkspaceSnapshot(id, {
        syncMode: options.force ? "force" : "preserve",
        systemPrompt: resolvedEntry.systemPrompt,
      });
    } catch (workspaceError) {
      const message = workspaceError instanceof Error
        ? workspaceError.message
        : String(workspaceError);
      error(`${id}: failed to snapshot workspace (${message})`);
      results.push({ id, ok: false, error: message });
      continue;
    }

    print(
      `  Workspace sync: ${workspaceSnapshot.syncMode} (${workspaceSnapshot.files.length} file(s))`,
    );

    const entrypoint = generateAgentEntrypoint(
      id,
      workspaceSnapshot,
    );
    const assets = await buildDeployAssets(entrypoint);
    const envVars = createDeployEnvVars({
      DENOCLAW_AGENT_ID: id,
      DENOCLAW_BROKER_URL: brokerUrl,
      DENOCLAW_AGENT_URL: getDeployAppEndpoint(app, resolvedDeployOrg),
      ...(brokerOidcAudience && brokerOidcAudience !== brokerUrl
        ? { DENOCLAW_BROKER_OIDC_AUDIENCE: brokerOidcAudience }
        : {}),
      ...(brokerToken ? { DENOCLAW_API_TOKEN: brokerToken } : {}),
    });

    print(`  Deploying (model: ${model}, perms: [${perms.join(",")}])...`);
    let revision;
    try {
      revision = await deployAppRevision({
        app,
        assets,
        envVars,
        headers,
      });
    } catch (deployError) {
      const message = deployError instanceof Error
        ? deployError.message
        : String(deployError);
      error(`${id}: ${message}`);
      results.push({ id, ok: false, error: message });
      continue;
    }

    const endpoint = getDeployAppEndpoint(app, resolvedDeployOrg);
    const domain = new URL(endpoint).host;

    success(`${id} deployed (${revision.id})`);
    print(`  URL: ${endpoint}`);

    try {
      if (!brokerToken) {
        throw new Error(
          "broker registration requires DENOCLAW_API_TOKEN or an interactive broker token",
        );
      }
      await registerAgentEndpointWithBroker({
        brokerUrl,
        authToken: brokerToken,
        agentId: id,
        endpoint,
        config: createBrokerOwnedAgentConfig(resolvedEntry),
      });
      success(`  Registered with broker: ${id}`);
    } catch (registerError) {
      const message = registerError instanceof Error
        ? registerError.message
        : String(registerError);
      error(`${id}: broker registration failed (${message})`);
      results.push({ id, ok: false, domain, error: message });
      continue;
    }

    results.push({ id, ok: true, domain });
  }

  if (!config.deploy) config.deploy = {};
  config.deploy.url = brokerUrl;
  if (brokerOidcAudience) {
    config.deploy.oidcAudience = brokerOidcAudience;
  }
  await saveConfig(config);

  const published = results.filter((r) => r.ok).length;
  output(
    { published, total: results.length, results },
    `\n✓ ${published}/${results.length} agent(s) published to Deno Deploy v2`,
  );
}
