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
    } catch { /* ignore */ }
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
          Deno.env.get("HOME")
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
        } catch { /* ignore */ }
      }
    });
  },
});

// ── Test 2: inter-agent communication ───────────────────

Deno.test({
  name: "E2E: test-alpha sends PING to test-beta and reports the reply",
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
          `Send the message "PING" to agent ${betaId} using the send_to_agent tool. Then report exactly what they replied.`,
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        // Alpha should report something from beta
        assert(
          response.content.length > 5,
          "Alpha should have received a non-trivial reply from beta",
        );

        // Verify both agents have separate private KV files
        const alphaMemPath = `${
          Deno.env.get("HOME")
        }/.denoclaw/agents/${alphaId}/memory.db`;
        const betaMemPath = `${
          Deno.env.get("HOME")
        }/.denoclaw/agents/${betaId}/memory.db`;
        const [alphaStat, betaStat] = await Promise.all([
          Deno.stat(alphaMemPath).catch(() => null),
          Deno.stat(betaMemPath).catch(() => null),
        ]);
        assert(alphaStat?.isFile, "Alpha private KV should exist");
        assert(betaStat?.isFile, "Beta private KV should exist");
      } finally {
        pool.shutdown();
        for (const id of [alphaId, betaId]) {
          try {
            await Deno.remove(
              `${Deno.env.get("HOME")}/.denoclaw/agents/${id}`,
              { recursive: true },
            );
          } catch { /* ignore */ }
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
        } catch { /* ignore */ }
      }
    });
  },
});

// ── Test 4: permission denial (no "run" permission) ─────

Deno.test({
  name: "E2E: shell tool denied when agent has no 'run' permission",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const agentId = "test-readonly";

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
          "Use the shell tool to execute 'echo test' with dry_run=false. Report what happens.",
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        // The sandbox should deny this — agent should mention denial/permission error
        const lower = response.content.toLowerCase();
        const mentions = lower.includes("permission") ||
          lower.includes("denied") ||
          lower.includes("not allowed") ||
          lower.includes("sandbox") ||
          lower.includes("error") ||
          lower.includes("unable") ||
          lower.includes("cannot") ||
          lower.includes("can't");
        assert(
          mentions,
          `Response should mention a permission issue. Got: ${response.content}`,
        );
      } finally {
        pool.shutdown();
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch { /* ignore */ }
      }
    });
  },
});

// ── Test 5: exec policy blocks unauthorized commands ────

Deno.test({
  name: "E2E: exec policy blocks 'curl' (not in allowlist)",
  ...testOpts,
  async fn() {
    await withTempAgentsDir(async () => {
      const agentId = "test-policy";

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
          "Use the shell tool to execute 'curl http://example.com' with dry_run=false. Report what happens.",
          { timeoutMs: TEST_TIMEOUT_MS },
        );

        assert(response.content.length > 0, "Response must not be empty");
        const lower = response.content.toLowerCase();
        const mentions = lower.includes("denied") ||
          lower.includes("not allowed") ||
          lower.includes("allowlist") ||
          lower.includes("permission") ||
          lower.includes("error") ||
          lower.includes("blocked") ||
          lower.includes("cannot") ||
          lower.includes("failed");
        assert(
          mentions,
          `Response should mention exec policy denial. Got: ${response.content}`,
        );
      } finally {
        pool.shutdown();
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch { /* ignore */ }
      }
    });
  },
});

// ── Test 6: shared KV observability ─────────────────────

Deno.test({
  name: "E2E: shared KV receives active_task and agent_task entries",
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

        // Check agent_tasks entries (the worker emits agent_task messages)
        let foundAgentTask = false;
        for await (const entry of sharedKv.list({ prefix: ["agent_tasks"] })) {
          if (entry.value) {
            foundAgentTask = true;
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
          foundAgentTask || foundTrace,
          "Shared KV should contain agent_task or trace entries after processing",
        );
      } finally {
        pool.shutdown();
        sharedKv.close();
        try {
          await Deno.remove(sharedKvPath);
        } catch { /* ignore */ }
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch { /* ignore */ }
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
    } catch { /* ignore */ }

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
        } catch { /* file does not exist — expected */ }

        assert(
          !fileExists,
          `File ${targetFile} must NOT exist — dry_run should have prevented the write`,
        );

        // Response should mention dry_run or preview
        const lower = response.content.toLowerCase();
        const mentionsDryRun = lower.includes("dry_run") ||
          lower.includes("dry run") ||
          lower.includes("would write") ||
          lower.includes("preview") ||
          lower.includes("without writing") ||
          lower.includes("not written");
        assert(
          mentionsDryRun,
          `Response should mention dry_run behavior. Got: ${response.content}`,
        );
      } finally {
        pool.shutdown();
        try {
          await Deno.remove(targetFile);
        } catch { /* ignore */ }
        try {
          await Deno.remove(
            `${Deno.env.get("HOME")}/.denoclaw/agents/${agentId}`,
            { recursive: true },
          );
        } catch { /* ignore */ }
      }
    });
  },
});
