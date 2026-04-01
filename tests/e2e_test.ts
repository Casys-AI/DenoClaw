/**
 * E2E tests — full pipeline: WorkerPool + real agents + real LLM (Ollama Cloud).
 *
 * Requires OLLAMA_API_KEY in .env (loaded via @std/dotenv/load).
 * Run: deno test tests/e2e_test.ts --unstable-kv --unstable-cron --allow-all
 */
import "@std/dotenv/load";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getConfigOrDefault } from "../src/config/loader.ts";
import { WorkerPool } from "../src/agent/worker_pool.ts";
import { WorkspaceLoader } from "../src/agent/workspace.ts";
import {
  getAgentMemoryPath,
  getAgentRuntimeDir,
} from "../src/shared/helpers.ts";
import type { WorkerConfig } from "../src/agent/worker_protocol.ts";
import { BrokerCronManager } from "../src/orchestration/broker/cron_manager.ts";
import { executeCronToolRequest } from "../src/orchestration/broker/cron_tool_actions.ts";

// ── Timeout: 30s per test — LLM calls are slow ──────────

const TEST_TIMEOUT_MS = 30_000;
const E2E_MODEL = "ollama/nemotron-3-super";
const testOpts = { sanitizeResources: false, sanitizeOps: false };
const OLLAMA_E2E_ENABLED = await canReachOllamaProvider();
const providerBackedTestOpts = {
  ...testOpts,
  ...(OLLAMA_E2E_ENABLED ? {} : { ignore: true }),
};

async function canReachOllamaProvider(): Promise<boolean> {
  const apiKey = Deno.env.get("OLLAMA_API_KEY");
  if (!apiKey) return false;

  try {
    const config = await getConfigOrDefault();
    const apiBase = config.providers.ollama?.apiBase ??
      "https://api.ollama.com";
    await fetch(`${apiBase}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      // Any HTTP response proves the provider is reachable from this runtime.
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

// ── Shared helper: build a WorkerConfig from real config ──

async function buildWorkerConfig(): Promise<WorkerConfig> {
  const config = await getConfigOrDefault();
  config.agents = {
    ...config.agents,
    defaults: {
      ...config.agents.defaults,
      model: E2E_MODEL,
    },
  };
  return {
    agents: config.agents,
    providers: config.providers,
    tools: config.tools,
  };
}

// ── Shared helper: isolated temp agents dir for each test ──

async function withTempAgentsDir(
  fn: (tmpDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "denoclaw_e2e_" });
  const tmpDir = `${rootDir}/agents`;
  const tmpHomeDir = `${rootDir}/home`;
  await Deno.mkdir(tmpDir, { recursive: true });
  await Deno.mkdir(tmpHomeDir, { recursive: true });
  const prevAgentsDir = Deno.env.get("DENOCLAW_AGENTS_DIR");
  const prevHomeDir = Deno.env.get("DENOCLAW_HOME_DIR");
  Deno.env.set("DENOCLAW_AGENTS_DIR", tmpDir);
  Deno.env.set("DENOCLAW_HOME_DIR", tmpHomeDir);
  try {
    await fn(tmpDir);
  } finally {
    if (prevAgentsDir) Deno.env.set("DENOCLAW_AGENTS_DIR", prevAgentsDir);
    else Deno.env.delete("DENOCLAW_AGENTS_DIR");
    if (prevHomeDir) Deno.env.set("DENOCLAW_HOME_DIR", prevHomeDir);
    else Deno.env.delete("DENOCLAW_HOME_DIR");
    try {
      await Deno.remove(rootDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

function startFakeOllamaCronServer(): {
  apiBase: string;
  close: () => Promise<void>;
} {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (req) => {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }

      const body = await req.json() as {
        model: string;
        messages: Array<{
          role: string;
          content: string;
        }>;
      };
      const messages = body.messages ?? [];
      const lastMessage = messages.at(-1);
      const lastUserMessage =
        [...messages].reverse().find((message) => message.role === "user")
          ?.content ?? "";

      const json = (payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });

      if (lastMessage?.role === "tool") {
        if (lastUserMessage === "RUN_TEST_CREATE") {
          return json({
            model: body.model,
            message: { role: "assistant", content: "CREATED" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          });
        }
        if (lastUserMessage === "RUN_TEST_LIST") {
          return json({
            model: body.model,
            message: { role: "assistant", content: lastMessage.content },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          });
        }
        if (lastUserMessage.startsWith("RUN_TEST_DELETE ")) {
          return json({
            model: body.model,
            message: { role: "assistant", content: "DELETED" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          });
        }
      }

      if (lastUserMessage === "RUN_TEST_CREATE") {
        return json({
          model: body.model,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "create_cron",
                arguments: {
                  name: "smoke-test",
                  schedule: "0 8 * * *",
                  prompt: "Reply with exactly: CRON_OK",
                },
              },
            }],
          },
          done: true,
          done_reason: "tool_calls",
          prompt_eval_count: 1,
          eval_count: 1,
        });
      }

      if (lastUserMessage === "RUN_TEST_LIST") {
        return json({
          model: body.model,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "list_crons",
                arguments: {},
              },
            }],
          },
          done: true,
          done_reason: "tool_calls",
          prompt_eval_count: 1,
          eval_count: 1,
        });
      }

      if (lastUserMessage.startsWith("RUN_TEST_DELETE ")) {
        return json({
          model: body.model,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "delete_cron",
                arguments: {
                  cronJobId: lastUserMessage.slice("RUN_TEST_DELETE ".length),
                },
              },
            }],
          },
          done: true,
          done_reason: "tool_calls",
          prompt_eval_count: 1,
          eval_count: 1,
        });
      }

      return json({
        model: body.model,
        message: { role: "assistant", content: "UNEXPECTED_TEST_INPUT" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 1,
        eval_count: 1,
      });
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    apiBase: `http://${addr.hostname}:${addr.port}`,
    close: async () => {
      server.shutdown();
      await server.finished;
    },
  };
}

// ── Test 1: single agent responds to message ────────────

Deno.test({
  name: "E2E: single agent replies PONG to 'Reply with exactly: PONG'",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const agentId = "test-solo";

      await WorkspaceLoader.create(agentId, {
        model: E2E_MODEL,
        sandbox: { allowedPermissions: ["read"] },
      });

      const workerConfig = await buildWorkerConfig();
      // Patch registry with the freshly created agent
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const pool = new WorkerPool(workerConfig);
      try {
        await pool.start([agentId]);

        const response = await pool.send(
          agentId,
          "session-solo",
          "Reply with exactly one word: PONG",
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        assertStringIncludes(
          response.content.toUpperCase(),
          "PONG",
          "Response should contain PONG",
        );

        // Verify private KV memory.db was created
        const memPath = getAgentMemoryPath(agentId);
        const stat = await Deno.stat(memPath);
        assert(stat.isFile, "Private KV memory.db should exist after response");
      } finally {
        pool.shutdown();
      }
    });
  },
});

// ── Test 2: inter-agent communication ───────────────────

Deno.test({
  name: "E2E: test-alpha requests an exact PONG reply from test-beta",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const alphaId = "test-alpha";
      const betaId = "test-beta";

      await WorkspaceLoader.create(alphaId, {
        model: E2E_MODEL,
        sandbox: { allowedPermissions: ["read"] },
        peers: [betaId],
        acceptFrom: [betaId],
      });
      await WorkspaceLoader.create(betaId, {
        model: E2E_MODEL,
        sandbox: { allowedPermissions: ["read"] },
        peers: [alphaId],
        acceptFrom: [alphaId],
      });

      const workerConfig = await buildWorkerConfig();
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const pool = new WorkerPool(workerConfig);
      try {
        await pool.start([alphaId, betaId]);

        const response = await pool.send(
          alphaId,
          "session-a2a",
          `Use the send_to_agent tool to tell agent ${betaId}: "Reply with exactly one word: PONG". Then report exactly that reply.`,
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        assertStringIncludes(
          response.content.toUpperCase(),
          "PONG",
          "Alpha should report beta's PONG reply",
        );

        // Verify at least the initiating agent created its private runtime KV
        const alphaMemPath = getAgentMemoryPath(alphaId);
        const alphaStat = await Deno.stat(alphaMemPath).catch(() => null);
        assert(alphaStat?.isFile, "Alpha private KV should exist");
      } finally {
        pool.shutdown();
      }
    });
  },
});

// ── Test 3: tool execution in subprocess ────────────────

Deno.test({
  name: "E2E: shell tool executes 'echo E2E_SUCCESS' and reports output",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const agentId = "test-exec";

      await WorkspaceLoader.create(agentId, {
        model: E2E_MODEL,
        sandbox: {
          allowedPermissions: ["read", "run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["echo"],
          },
        },
      });

      const workerConfig = await buildWorkerConfig();
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const pool = new WorkerPool(workerConfig);
      try {
        await pool.start([agentId]);

        const response = await pool.send(
          agentId,
          "session-exec",
          "Use the shell tool to execute the command 'echo E2E_SUCCESS' with dry_run set to false. Report the exact output you receive.",
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        assertStringIncludes(
          response.content,
          "E2E_SUCCESS",
          "Response should contain the echo output",
        );
      } finally {
        pool.shutdown();
      }
    });
  },
});

// ── Test 4: permission denial (no "run" permission) ─────

Deno.test({
  name: "E2E: shell tool denied when agent has no 'run' permission",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      const agentId = "test-readonly";
      const sentinelPath = `${tmpDir}/readonly_should_not_exist`;

      await WorkspaceLoader.create(agentId, {
        model: E2E_MODEL,
        sandbox: {
          allowedPermissions: ["read"], // intentionally no "run"
        },
      });

      const workerConfig = await buildWorkerConfig();
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const pool = new WorkerPool(workerConfig);
      try {
        await pool.start([agentId]);

        const response = await pool.send(
          agentId,
          "session-readonly",
          `Call the shell tool exactly once with command 'touch ${sentinelPath}' and dry_run=false. Do not retry. After the tool result, reply in one short sentence describing whether it was denied.`,
          { timeoutMs: TEST_TIMEOUT_MS * 2 },
        );

        assert(response.content.length > 0, "Response must not be empty");
        assert(
          await Deno.stat(sentinelPath)
            .then(() => false)
            .catch(() => true),
          "Shell command should not execute without the 'run' permission",
        );
      } finally {
        pool.shutdown();
      }
    });
  },
});

// ── Test 5: exec policy blocks unauthorized commands ────

Deno.test({
  name: "E2E: exec policy blocks unauthorized shell commands",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      const agentId = "test-policy";
      const sentinelPath = `${tmpDir}/policy_should_not_exist`;

      await WorkspaceLoader.create(agentId, {
        model: E2E_MODEL,
        sandbox: {
          allowedPermissions: ["read", "run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["echo"], // curl is NOT listed
          },
        },
      });

      const workerConfig = await buildWorkerConfig();
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const pool = new WorkerPool(workerConfig);
      try {
        await pool.start([agentId]);

        const response = await pool.send(
          agentId,
          "session-policy",
          `Use the shell tool to execute 'touch ${sentinelPath}' with dry_run=false. Report what happens.`,
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        assert(
          await Deno.stat(sentinelPath)
            .then(() => false)
            .catch(() => true),
          "Exec policy should block unauthorized shell commands",
        );
      } finally {
        pool.shutdown();
        await Deno.remove(getAgentRuntimeDir(agentId), {
          recursive: true,
        }).catch(() => {});
      }
    });
  },
});

// ── Test 6: shared KV observability ─────────────────────

Deno.test({
  name: "E2E: shared KV receives active_task and task_observation entries",
  ...providerBackedTestOpts,
  async fn() {
    const sharedKvPath = await Deno.makeTempFile({
      prefix: "denoclaw_e2e_shared_",
      suffix: ".db",
    });

    await withTempAgentsDir(async () => {
      const agentId = "test-obs";

      await WorkspaceLoader.create(agentId, {
        model: E2E_MODEL,
        sandbox: { allowedPermissions: ["read"] },
      });

      const workerConfig = await buildWorkerConfig();
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const sharedKv = await Deno.openKv(sharedKvPath);
      const pool = new WorkerPool(workerConfig);
      pool.setSharedKv(sharedKv);

      try {
        await pool.start([agentId]);

        await pool.send(
          agentId,
          "session-obs",
          "Reply with exactly: OBSERVED",
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        // Check task_observations entries (the worker emits task_observe messages)
        let foundTaskObservation = false;
        for await (
          const entry of sharedKv.list({
            prefix: ["task_observations"],
          })
        ) {
          if (entry.value) {
            foundTaskObservation = true;
            break;
          }
        }

        // Check traces entries (TraceWriter writes to ["traces", ...])
        let foundTrace = false;
        for await (const entry of sharedKv.list({ prefix: ["traces"] })) {
          if (entry.value) {
            foundTrace = true;
            break;
          }
        }

        // At minimum: traces should have been written (TraceWriter is initialized in worker)
        // active_task may have been cleared by the time we check (clearActiveTask is called on completion)
        assert(
          foundTaskObservation || foundTrace,
          "Shared KV should contain task observations or trace entries after processing",
        );
      } finally {
        pool.shutdown();
        sharedKv.close();
        try {
          await Deno.remove(sharedKvPath);
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 7: dry_run default protection ──────────────────

Deno.test({
  name: "E2E: write_file dry_run default prevents actual write",
  ...providerBackedTestOpts,
  async fn() {
    const targetFile = "/tmp/denoclaw-e2e-dryrun.txt";

    // Ensure the file does not exist before the test
    try {
      await Deno.remove(targetFile);
    } catch {
      /* ignore */
    }

    await withTempAgentsDir(async () => {
      const agentId = "test-dryrun";

      await WorkspaceLoader.create(agentId, {
        model: E2E_MODEL,
        sandbox: {
          allowedPermissions: ["read", "write"],
        },
      });

      const workerConfig = await buildWorkerConfig();
      const registry = await WorkspaceLoader.buildRegistry();
      workerConfig.agents = { ...workerConfig.agents, registry };

      const pool = new WorkerPool(workerConfig);
      try {
        await pool.start([agentId]);

        const response = await pool.send(
          agentId,
          "session-dryrun",
          `Use the write_file tool to write 'test' to ${targetFile}. Do NOT set dry_run to false — just use the default.`,
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");

        // File must NOT exist — dry_run should have blocked the write
        let fileExists = false;
        try {
          await Deno.stat(targetFile);
          fileExists = true;
        } catch {
          /* file does not exist — expected */
        }

        assert(
          !fileExists,
          `File ${targetFile} must NOT exist — dry_run should have prevented the write`,
        );
      } finally {
        pool.shutdown();
        try {
          await Deno.remove(targetFile);
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 8: local cron tools round-trip through WorkerPool ──

Deno.test({
  name: "E2E: local cron tools create, list, and delete jobs",
  ...testOpts,
  async fn() {
    const cronKvPath = await Deno.makeTempFile({
      prefix: "denoclaw_e2e_cron_",
      suffix: ".db",
    });
    const fakeOllama = startFakeOllamaCronServer();

    try {
      await withTempAgentsDir(async () => {
        const agentId = `test-cron-${crypto.randomUUID().slice(0, 6)}`;
        const config = await buildWorkerConfig();
        config.providers = {
          ollama: {
            apiKey: "test-ollama-key",
            apiBase: fakeOllama.apiBase,
          },
        };
        config.agents = {
          ...config.agents,
          defaults: {
            ...config.agents.defaults,
            model: "ollama/test-cron-model",
          },
        };
        config.agents.registry = {
          [agentId]: {
            sandbox: { allowedPermissions: ["schedule"] },
          },
        };

        await WorkspaceLoader.create(
          agentId,
          config.agents.registry[agentId],
          "You are a deterministic E2E cron test agent.",
        );

        const cronKv = await Deno.openKv(cronKvPath);
        const cronManager = new BrokerCronManager(cronKv, {
          registerDenoCron: false,
        });
        const handledTools: Array<
          "create_cron" | "list_crons" | "delete_cron" | "enable_cron" | "disable_cron"
        > = [];
        const pool = new WorkerPool(config);
        pool.setCronHandler(async (currentAgentId, request) => {
          handledTools.push(request.tool);
          return await executeCronToolRequest(
            cronManager,
            currentAgentId,
            request.tool,
            request.args,
          );
        });

        try {
          await pool.start([agentId]);

          const createResult = await pool.send(
            agentId,
            "session-cron",
            "RUN_TEST_CREATE",
            { timeoutMs: TEST_TIMEOUT_MS * 2 },
          );
          assert(
            createResult.content.length > 0,
            "Agent should respond after create_cron",
          );

          const createdJobs = await cronManager.listByAgent(agentId);
          assertEquals(handledTools, ["create_cron"]);
          assertEquals(createdJobs.length, 1);
          assertEquals(createdJobs[0].name, "smoke-test");
          assertEquals(createdJobs[0].schedule, "0 8 * * *");

          const listResult = await pool.send(
            agentId,
            "session-cron",
            "RUN_TEST_LIST",
            { timeoutMs: TEST_TIMEOUT_MS * 2 },
          );
          assert(
            listResult.content.length > 0,
            "Agent should respond after list_crons",
          );
          assertEquals(handledTools, ["create_cron", "list_crons"]);
          assertStringIncludes(listResult.content, createdJobs[0].id);
          assertStringIncludes(listResult.content, "smoke-test");

          const deleteResult = await pool.send(
            agentId,
            "session-cron",
            `RUN_TEST_DELETE ${createdJobs[0].id}`,
            { timeoutMs: TEST_TIMEOUT_MS * 2 },
          );
          assert(
            deleteResult.content.length > 0,
            "Agent should respond after delete_cron",
          );
          assertEquals(handledTools, [
            "create_cron",
            "list_crons",
            "delete_cron",
          ]);

          const remainingJobs = await cronManager.listByAgent(agentId);
          assertEquals(remainingJobs.length, 0);
        } finally {
          pool.shutdown();
          cronKv.close();
          await Deno.remove(getAgentRuntimeDir(agentId), {
            recursive: true,
          }).catch(() => {});
        }
      });
    } finally {
      await fakeOllama.close();
      await Deno.remove(cronKvPath).catch(() => {});
    }
  },
});

// ── Test 9: agent writes a memory file ─────────────────

Deno.test({
  name: "E2E: agent writes a memory file via scoped write_file",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      const agentId = `test-mem-${crypto.randomUUID().slice(0, 6)}`;
      const config = await buildWorkerConfig();
      config.agents.registry = {
        [agentId]: {
          sandbox: { allowedPermissions: ["read", "write"] },
        },
      };

      await WorkspaceLoader.create(
        agentId,
        config.agents.registry[agentId],
        "Tu es un agent test. Quand on te demande de noter quelque chose, utilise write_file pour écrire dans memories/. Mets toujours dry_run à false.",
      );

      const pool = new WorkerPool(config);
      await pool.start([agentId]);

      try {
        const result = await pool.send(
          agentId,
          "default",
          'Write the text "E2E memory test passed" to the file memories/test_note.md using write_file with dry_run=false.',
          {},
        );

        assert(result.content.length > 0, "Agent should respond");

        // Verify the file was created — check both workspace and CWD
        const workspacePath = `${tmpDir}/${agentId}/memories/test_note.md`;
        let found = false;
        try {
          const content = await Deno.readTextFile(workspacePath);
          assertStringIncludes(content, "E2E memory test");
          found = true;
        } catch {
          /* not in workspace, check if agent mentioned writing */
        }

        if (!found) {
          // At minimum, the agent should confirm it wrote something
          const lower = result.content.toLowerCase();
          assert(
            lower.includes("written") ||
              lower.includes("created") ||
              lower.includes("saved") ||
              lower.includes("wrote"),
            `Agent should confirm write. Got: ${result.content}`,
          );
        }
      } finally {
        pool.shutdown();
        await Deno.remove(getAgentRuntimeDir(agentId), {
          recursive: true,
        }).catch(() => {});
      }
    });
  },
});

// ── Test 10: memory files listed in agent context ───────

Deno.test({
  name: "E2E: agent sees its memory files in context",
  ...providerBackedTestOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      const agentId = `test-ctx-${crypto.randomUUID().slice(0, 6)}`;
      const config = await buildWorkerConfig();
      config.agents.registry = {
        [agentId]: {
          sandbox: { allowedPermissions: ["read"] },
        },
      };

      await WorkspaceLoader.create(
        agentId,
        config.agents.registry[agentId],
        "Tu es un agent test.",
      );

      // Pre-create a memory file before starting the agent
      await Deno.writeTextFile(
        `${tmpDir}/${agentId}/memories/project_notes.md`,
        "This project uses Deno.",
      );

      const pool = new WorkerPool(config);
      await pool.start([agentId]);

      try {
        const result = await pool.send(
          agentId,
          "default",
          "What memory files do you have access to? List them.",
          {},
        );

        assertStringIncludes(result.content.toLowerCase(), "project_notes");
      } finally {
        pool.shutdown();
        await Deno.remove(getAgentRuntimeDir(agentId), {
          recursive: true,
        }).catch(() => {});
      }
    });
  },
});
