import { getConfigOrDefault, saveConfig } from "../../config/mod.ts";
import { getDeployOrgToken } from "../../shared/deploy_credentials.ts";
import { deriveBrokerAppName } from "../../shared/naming.ts";
import { ask, error, print, success } from "../prompt.ts";
import {
  createDeployApiHeaders,
  updateDeployAppConfig,
} from "../deploy_api.ts";
import { resolveBrokerDeployNaming } from "./broker_deploy_naming.ts";

export async function deployBroker(opts?: {
  org?: string;
  app?: string;
  region?: string;
  prod?: boolean;
}): Promise<void> {
  const config = await getConfigOrDefault();
  const deployToken = getDeployOrgToken() ??
    await ask("Deno Deploy organization access token");
  const canonicalBrokerApp = deriveBrokerAppName();

  const org = opts?.org || config.deploy?.org ||
    await ask("Deploy org", config.deploy?.org || "casys");
  const storedApp = config.deploy?.app;
  const storedNaming = resolveBrokerDeployNaming({
    storedApp,
    storedKvDatabase: config.deploy?.kvDatabase,
    canonicalBrokerApp,
  });
  const app = opts?.app ??
    (storedApp
      ? storedNaming.app
      : await ask("Deploy app name", canonicalBrokerApp));
  const resolvedNaming = (opts?.app === undefined && storedApp)
    ? storedNaming
    : resolveBrokerDeployNaming({
      requestedApp: app,
      storedApp,
      storedKvDatabase: config.deploy?.kvDatabase,
      canonicalBrokerApp,
    });
  const region = opts?.region || config.deploy?.region || "global";
  const kvDatabase = resolvedNaming.kvDatabase;

  if (!org || !app) {
    error("Organization and app name are required. Use --org and --app.");
    return;
  }

  for (const notice of resolvedNaming.migrationNotices) {
    print(notice);
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
    cliOpts?: { cwd?: string; echo?: boolean },
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const cmd = new Deno.Command("deno", {
      args,
      cwd: cliOpts?.cwd,
      env: cliEnv,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    const stdout = decoder.decode(result.stdout).trim();
    const stderr = decoder.decode(result.stderr).trim();

    if (cliOpts?.echo) {
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

  if (!await ensureBrokerApp()) return;

  async function ensureBrokerKvDatabase(): Promise<void> {
    print(`Ensuring shared KV database ${kvDatabase}...`);

    const provisionResult = await runDeployCli([
      "deploy",
      "database",
      "provision",
      kvDatabase,
      "--kind",
      "denokv",
      "--org",
      org,
    ], { cwd: "/tmp" });

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

    const assignResult = await runDeployCli([
      "deploy",
      "database",
      "assign",
      kvDatabase,
      "--org",
      org,
      "--app",
      app,
    ], { cwd: "/tmp" });

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

  async function upsertDeployEnvVar(key: string, value: string): Promise<void> {
    const addResult = await runDeployCli([
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
    ], { cwd: "/tmp" });

    if (addResult.success) return;

    const combined = `${addResult.stdout}\n${addResult.stderr}`.toLowerCase();
    if (
      combined.includes("already exists") ||
      combined.includes("already been taken")
    ) {
      const updateResult = await runDeployCli([
        "deploy",
        "env",
        "update-value",
        "--org",
        org,
        "--app",
        app,
        key,
        value,
      ], { cwd: "/tmp" });

      if (updateResult.success) return;

      const body = `${updateResult.stdout}\n${updateResult.stderr}`.trim();
      throw new Error(`failed to update env var ${key}: ${body}`.trim());
    }

    const body = `${addResult.stdout}\n${addResult.stderr}`.trim();
    throw new Error(`failed to add env var ${key}: ${body}`.trim());
  }

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

  let apiToken = Deno.env.get("DENOCLAW_API_TOKEN");
  if (!apiToken) {
    apiToken = crypto.randomUUID();
  }

  print("Setting DENOCLAW_API_TOKEN...");
  await upsertDeployEnvVar("DENOCLAW_API_TOKEN", apiToken);

  print("Setting DENOCLAW_SANDBOX_API_TOKEN...");
  await upsertDeployEnvVar("DENOCLAW_SANDBOX_API_TOKEN", deployToken);

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
