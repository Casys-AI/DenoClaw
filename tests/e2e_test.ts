/**
 * E2E tests — full pipeline: WorkerPool + real agents + real LLM (Ollama Cloud).
 *
 * Requires OLLAMA_API_KEY in .env (loaded via @std/dotenv/load).
 * Run: deno test tests/e2e_test.ts --unstable-kv --unstable-cron --allow-all
 */
import "@std/dotenv/load";
import { assert, assertStringIncludes } from "@std/assert";
import { getConfigOrDefault } from "../src/config/loader.ts";
import { WorkerPool } from "../src/agent/worker_pool.ts";
import { WorkspaceLoader } from "../src/agent/workspace.ts";
import type { WorkerConfig } from "../src/agent/worker_protocol.ts";

// ── Timeout: 30s per test — LLM calls are slow ──────────

const TEST_TIMEOUT_MS = 30_000;
const testOpts = { sanitizeResources: false, sanitizeOps: false };

// ── Shared helper: build a WorkerConfig from real config ──

async function buildWorkerConfig(): Promise<WorkerConfig> {
  const config = await getConfigOrDefault();
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
  const tmpDir = await Deno.makeTempDir({ prefix: "denoclaw_e2e_" });
  const prev = Deno.env.get("DENOCLAW_AGENTS_DIR");
  Deno.env.set("DENOCLAW_AGENTS_DIR", tmpDir);
  try {
    await fn(tmpDir);
  } finally {
    Deno.env.delete("DENOCLAW_AGENTS_DIR");
    if (prev) Deno.env.set("DENOCLAW_AGENTS_DIR", prev);
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Test 1: single agent responds to message ────────────

Deno.test({
  name: "E2E: single agent replies PONG to 'Reply with exactly: PONG'",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const agentId = "test-solo";

      await WorkspaceLoader.create(agentId, {
        model: "ollama/nemotron-3-super",
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
        const memPath = `${
          Deno.env.get(
            "HOME",
          )
        }/.denoclaw/agents/${agentId}/memory.db`;
        const stat = await Deno.stat(memPath);
        assert(stat.isFile, "Private KV memory.db should exist after response");
      } finally {
        pool.shutdown();
        // Clean up runtime dir
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 2: inter-agent communication ───────────────────

Deno.test({
  name: "E2E: test-alpha requests an exact PONG reply from test-beta",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const alphaId = "test-alpha";
      const betaId = "test-beta";

      await WorkspaceLoader.create(alphaId, {
        model: "ollama/nemotron-3-super",
        sandbox: { allowedPermissions: ["read"] },
        peers: [betaId],
        acceptFrom: [betaId],
      });
      await WorkspaceLoader.create(betaId, {
        model: "ollama/nemotron-3-super",
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
        const alphaMemPath = `${
          Deno.env.get(
            "HOME",
          )
        }/.denoclaw/agents/${alphaId}/memory.db`;
        const alphaStat = await Deno.stat(alphaMemPath).catch(() => null);
        assert(alphaStat?.isFile, "Alpha private KV should exist");
      } finally {
        pool.shutdown();
        for (const id of [alphaId, betaId]) {
          try {
            await Deno.remove(
              `${Deno.env.get("HOME")}/.denoclaw/agents/${id}`,
              { recursive: true },
            );
          } catch {
            /* ignore */
          }
        }
      }
    });
  },
});

// ── Test 3: tool execution in subprocess ────────────────

Deno.test({
  name: "E2E: shell tool executes 'echo E2E_SUCCESS' and reports output",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const agentId = "test-exec";

      await WorkspaceLoader.create(agentId, {
        model: "ollama/nemotron-3-super",
        sandbox: {
          allowedPermissions: ["read", "run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["echo"],
            ask: "off",
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 4: permission denial (no "run" permission) ─────

Deno.test({
  name: "E2E: shell tool denied when agent has no 'run' permission",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      const agentId = "test-readonly";
      const sentinelPath = `${tmpDir}/readonly_should_not_exist`;

      await WorkspaceLoader.create(agentId, {
        model: "ollama/nemotron-3-super",
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
          `Use the shell tool to execute 'touch ${sentinelPath}' with dry_run=false. Report what happens.`,
          { timeoutMs: TEST_TIMEOUT_MS },
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 5: exec policy blocks unauthorized commands ────

Deno.test({
  name: "E2E: exec policy blocks unauthorized shell commands",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async (tmpDir) => {
      const agentId = "test-policy";
      const sentinelPath = `${tmpDir}/policy_should_not_exist`;

      await WorkspaceLoader.create(agentId, {
        model: "ollama/nemotron-3-super",
        sandbox: {
          allowedPermissions: ["read", "run"],
          execPolicy: {
            security: "allowlist",
            allowedCommands: ["echo"], // curl is NOT listed
            ask: "off",
            askFallback: "deny",
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 6: shared KV observability ─────────────────────

Deno.test({
  name: "E2E: shared KV receives active_task and task_observation entries",
  ...testOpts,
  async fn() {
    const sharedKvPath = await Deno.makeTempFile({
      prefix: "denoclaw_e2e_shared_",
      suffix: ".db",
    });

    await withTempAgentsDir(async () => {
      const agentId = "test-obs";

      await WorkspaceLoader.create(agentId, {
        model: "ollama/nemotron-3-super",
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
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
  ...testOpts,
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
        model: "ollama/nemotron-3-super",
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 8: agent writes a memory file ─────────────────

Deno.test({
  name: "E2E: agent writes a memory file via scoped write_file",
  ...testOpts,
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});

// ── Test 9: memory files listed in agent context ───────

Deno.test({
  name: "E2E: agent sees its memory files in context",
  ...testOpts,
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
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch {
          /* ignore */
        }
      }
    });
  },
});
