import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));
const MAIN_TS = fromFileUrl(new URL("../main.ts", import.meta.url));

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function withTempCliEnv(
  fn: (ctx: {
    rootDir: string;
    agentsDir: string;
    homeDir: string;
    env: Record<string, string>;
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "denoclaw_cli_e2e_" });
  const agentsDir = join(rootDir, "agents");
  const homeDir = join(rootDir, "home");
  await Deno.mkdir(agentsDir, { recursive: true });
  await Deno.mkdir(homeDir, { recursive: true });

  try {
    await fn({
      rootDir,
      agentsDir,
      homeDir,
      env: {
        ...Deno.env.toObject(),
        DENOCLAW_AGENTS_DIR: agentsDir,
        DENOCLAW_HOME_DIR: homeDir,
        LOG_LEVEL: "error",
      },
    });
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<CliRunResult> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-kv",
      "--unstable-cron",
      "--allow-all",
      "--env",
      MAIN_TS,
      ...args,
    ],
    cwd: REPO_ROOT,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const decoder = new TextDecoder();
  const result = await cmd.output();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

function parseSingleJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  assertEquals(lines.length, 1, `expected a single JSON line, got: ${stdout}`);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

Deno.test("CLI E2E: status --json emits only one structured payload", async () => {
  await withTempCliEnv(async ({ env }) => {
    const result = await runCli(["status", "--json"], env);

    assertEquals(result.code, 0);
    assertEquals(result.stderr, "");

    const payload = parseSingleJsonLine(result.stdout);
    assert(Array.isArray(payload.providers), "providers should be an array");
    assertEquals(payload.model, "anthropic/claude-sonnet-4-6");
    assertEquals(payload.channels, []);
    assertEquals(payload.routeScopes, 0);
    assertEquals(payload.deploy, null);
  });
});

Deno.test("CLI E2E: status --json reflects configured providers, channels, and deploy metadata", async () => {
  await withTempCliEnv(async ({ homeDir, env }) => {
    await Deno.writeTextFile(
      join(homeDir, "config.json"),
      JSON.stringify(
        {
          providers: {
            anthropic: { apiKey: "test-anthropic-key" },
            ollama: { apiKey: "test-ollama-key" },
          },
          agents: {
            defaults: {
              model: "openai/gpt-4o-mini",
              temperature: 0.1,
              maxTokens: 2048,
            },
          },
          tools: {
            restrictToWorkspace: true,
          },
          channels: {
            telegram: {
              enabled: true,
              accounts: [{
                accountId: "telegram-bot",
                tokenEnvVar: "TG_TOKEN",
              }],
            },
            discord: {
              enabled: true,
              accounts: [{
                accountId: "discord-bot",
                tokenEnvVar: "DISCORD_TOKEN",
              }],
            },
            webhook: {
              enabled: true,
              port: 8787,
            },
            routing: {
              scopes: [
                {
                  scope: {
                    channelType: "telegram",
                    accountId: "telegram-bot",
                    roomId: "team-room",
                  },
                  delivery: "direct",
                  targetAgentIds: ["alice"],
                },
                {
                  scope: {
                    channelType: "discord",
                    accountId: "discord-bot",
                    threadId: "incident-thread",
                  },
                  delivery: "broadcast",
                  targetAgentIds: ["alice", "bob"],
                },
              ],
            },
          },
          deploy: {
            app: "broker-app",
            region: "eu-west-1",
            kvDatabase: "kv-123",
          },
        },
        null,
        2,
      ),
    );

    const result = await runCli(["status", "--json"], env);

    assertEquals(result.code, 0);
    assertEquals(result.stderr, "");

    const payload = parseSingleJsonLine(result.stdout);
    assertEquals(payload.providers, [
      "anthropic (key)",
      "ollama (key)",
    ]);
    assertEquals(payload.model, "openai/gpt-4o-mini");
    assertEquals(payload.channels, ["telegram", "discord", "webhook"]);
    assertEquals(payload.routeScopes, 2);
    assertEquals(payload.deploy, {
      app: "broker-app",
      region: "eu-west-1",
      kvDatabase: "kv-123",
    });
  });
});

Deno.test("CLI E2E: agent create and delete mutate the workspace through main.ts", async () => {
  await withTempCliEnv(async ({ agentsDir, env }) => {
    const createResult = await runCli([
      "agent",
      "create",
      "alice",
      "--description",
      "Test helper",
      "--model",
      "openai/gpt-4o",
      "--system-prompt",
      "You are Alice.",
      "--permissions",
      "read,write",
    ], env);

    assertEquals(createResult.code, 0);
    assertStringIncludes(createResult.stdout, 'Agent "alice" created');

    const agentJsonPath = join(agentsDir, "alice", "agent.json");
    const soulPath = join(agentsDir, "alice", "soul.md");
    const agentJson = JSON.parse(await Deno.readTextFile(agentJsonPath)) as {
      description?: string;
      model?: string;
      sandbox?: { allowedPermissions?: string[] };
    };
    const soul = await Deno.readTextFile(soulPath);

    assertEquals(agentJson.description, "Test helper");
    assertEquals(agentJson.model, "openai/gpt-4o");
    assertEquals(agentJson.sandbox?.allowedPermissions, ["read", "write"]);
    assertStringIncludes(soul, "You are Alice.");

    const deleteResult = await runCli(
      ["agent", "delete", "alice", "--yes"],
      env,
    );
    assertEquals(deleteResult.code, 0);
    assertStringIncludes(deleteResult.stdout, 'Agent "alice" deleted');

    const removed = await Deno.stat(join(agentsDir, "alice"))
      .then(() => false)
      .catch(() => true);
    assert(removed, "agent workspace should be removed by delete");
  });
});

Deno.test("CLI E2E: deprecated deploy agent alias reuses canonical publish behavior", async () => {
  await withTempCliEnv(async ({ env }) => {
    const createResult = await runCli([
      "agent",
      "create",
      "alice",
      "--model",
      "openai/gpt-4o",
      "--permissions",
      "read",
    ], env);
    assertEquals(createResult.code, 0);

    const publishResult = await runCli(["publish", "alice", "--json"], env);
    assertEquals(publishResult.code, 0);
    assertEquals(publishResult.stderr, "");
    const publishPayload = parseSingleJsonLine(publishResult.stdout);
    assertEquals(publishPayload.code, "MISSING_BROKER_URL");

    const deprecatedResult = await runCli(
      ["deploy", "agent", "alice", "--json"],
      env,
    );
    assertEquals(deprecatedResult.code, 0);
    assertEquals(deprecatedResult.stderr, "");
    const deprecatedPayload = parseSingleJsonLine(deprecatedResult.stdout);
    assertEquals(deprecatedPayload.code, "MISSING_BROKER_URL");
    assertEquals(deprecatedPayload.error, publishPayload.error);
  });
});
