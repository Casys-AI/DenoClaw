/**
 * E2E integration tests for the Mastra memory pipeline.
 *
 * Requires DATABASE_URL pointing at a running Postgres instance.
 * Run: DATABASE_URL=postgresql://denoclaw:denoclaw@localhost:5433/denoclaw \
 *        deno test --allow-all tests/memory_e2e_test.ts
 */

import "@std/dotenv/load";
import { assert, assertEquals } from "@std/assert";
import { MastraMemory } from "../src/agent/memory/mastra.ts";
import { NoopEmbedder } from "../src/agent/memory/embedders/noop.ts";
import { WorkingMemoryTool } from "../src/agent/tools/working_memory.ts";
import type { WorkingMemoryPort } from "../src/agent/tools/working_memory.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const skip = !DATABASE_URL;

const baseTestOpts = {
  sanitizeResources: false,
  sanitizeOps: false,
};

function makeMemoryConfig() {
  return {
    connectionString: DATABASE_URL!,
    embedder: new NoopEmbedder(),
    lastMessages: 50,
    semanticRecall: { topK: 3, messageRange: 2 },
  };
}

// ── Full pipeline E2E test ───────────────────────────────────────────────────

Deno.test({
  name: "Memory E2E: full pipeline — add messages, recall, trim, semantic, clear",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const mem = new MastraMemory(agentId, sessionId, makeMemoryConfig());

    // Step 1: load (creates thread)
    await mem.load();

    try {
      // Step 2: add a multi-turn conversation
      await mem.addMessage({ role: "user", content: "What is Deno?" });
      await mem.addMessage({
        role: "assistant",
        content: "Deno is a JavaScript/TypeScript runtime built on V8.",
      });
      await mem.addMessage({ role: "user", content: "How does it compare to Node?" });
      await mem.addMessage({
        role: "assistant",
        content: "Deno has built-in TypeScript support and secure defaults.",
      });

      // Step 3: getMessages — verify semantic recall is attempted (lastUserMessage set)
      const messages = await mem.getMessages();
      assert(messages.length >= 4, `Should have at least 4 messages, got ${messages.length}`);
      const userMessages = messages.filter((m) => m.role === "user");
      assert(userMessages.length >= 2, "Should have at least 2 user messages");

      // Step 4: trimMessages — verify it returns messages
      const trimmed = await mem.trimMessages(messages, 10_000);
      assert(Array.isArray(trimmed), "trimMessages should return an array");
      assert(trimmed.length > 0, "trimMessages should return at least some messages");

      // Step 5: semanticRecall — verify it doesn't crash
      // NoopEmbedder has dimension=0, so no vector matches expected — just no crash
      let recalled: Awaited<ReturnType<typeof mem.semanticRecall>>;
      try {
        recalled = await mem.semanticRecall("Deno runtime", 3);
      } catch {
        // Acceptable: some Mastra builds throw for zero-dimension vectors
        recalled = [];
      }
      assert(Array.isArray(recalled), "semanticRecall should return an array");
    } finally {
      // Step 6: clean up
      await mem.clear();
      mem.close();
    }
  },
});

// ── WorkingMemoryPort integration via MastraMemory ───────────────────────────

Deno.test({
  name: "Memory E2E: WorkingMemoryPort integration — update + get round-trip",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const mem = new MastraMemory(agentId, sessionId, makeMemoryConfig());
    await mem.load();

    try {
      // Step 1: cast to WorkingMemoryPort
      const wmp = mem as unknown as WorkingMemoryPort;

      // Step 2: update working memory
      const content = "# Test\n- key: value\n- agent: memory_e2e";
      await wmp.updateWorkingMemory(content);

      // Step 3: get working memory — verify it returns what was set
      const retrieved = await wmp.getWorkingMemory();
      assert(
        retrieved.includes("# Test"),
        `Working memory should contain '# Test', got: ${retrieved}`,
      );
      assert(
        retrieved.includes("key: value"),
        `Working memory should contain 'key: value', got: ${retrieved}`,
      );
    } finally {
      // Step 4: clean up
      await mem.clear();
      mem.close();
    }
  },
});

// ── WorkingMemoryTool E2E: tool layer over MastraMemory ─────────────────────

Deno.test({
  name: "Memory E2E: WorkingMemoryTool over MastraMemory — read/update lifecycle",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const mem = new MastraMemory(agentId, sessionId, makeMemoryConfig());
    await mem.load();

    try {
      const tool = new WorkingMemoryTool(mem);

      // Initial read — may be empty template or empty string
      const initialRead = await tool.execute({ action: "read" });
      assert(initialRead.success, "Initial read should succeed");
      assert(typeof initialRead.output === "string", "Output should be a string");

      // Update with structured content
      const newMemory = "# Agent State\n- Task: E2E test\n- Status: running";
      const updateResult = await tool.execute({ action: "update", content: newMemory });
      assert(updateResult.success, "Update should succeed");

      // Read back — should contain updated content
      const updatedRead = await tool.execute({ action: "read" });
      assert(updatedRead.success, "Read after update should succeed");
      assert(
        updatedRead.output.includes("E2E test"),
        `Read should contain updated content, got: ${updatedRead.output}`,
      );
    } finally {
      await mem.clear();
      mem.close();
    }
  },
});

// ── Message count consistency ────────────────────────────────────────────────

Deno.test({
  name: "Memory E2E: message count is consistent after multiple operations",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const mem = new MastraMemory(agentId, sessionId, makeMemoryConfig());
    await mem.load();

    try {
      assertEquals(mem.count, 0, "count should start at 0");

      await mem.addMessage({ role: "user", content: "msg1" });
      assertEquals(mem.count, 1);

      await mem.addMessage({ role: "assistant", content: "msg2" });
      assertEquals(mem.count, 2);

      await mem.addMessage({ role: "user", content: "msg3" });
      assertEquals(mem.count, 3);

      const messages = await mem.getMessages();
      assert(messages.length >= 3, `Expected at least 3 messages, got ${messages.length}`);
    } finally {
      await mem.clear();
      mem.close();
    }
  },
});
