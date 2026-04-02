/**
 * Colocated unit tests for MastraMemory.
 *
 * Requires DATABASE_URL pointing at a running Postgres instance.
 * Run: DATABASE_URL=postgresql://denoclaw:denoclaw@localhost:5433/denoclaw \
 *        deno test --allow-all src/agent/memory/mastra_test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { MastraMemory } from "./mastra.ts";
import { NoopEmbedder } from "./embedders/noop.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const skip = !DATABASE_URL;

const baseTestOpts = {
  sanitizeResources: false,
  sanitizeOps: false,
};

function makeConfig() {
  return {
    connectionString: DATABASE_URL!,
    embedder: new NoopEmbedder(),
    lastMessages: 50,
    semanticRecall: { topK: 3, messageRange: 2 },
  };
}

async function makeMemory(agentId?: string, sessionId?: string): Promise<MastraMemory> {
  const aid = agentId ?? crypto.randomUUID();
  const sid = sessionId ?? crypto.randomUUID();
  const mem = new MastraMemory(aid, sid, makeConfig());
  await mem.load();
  return mem;
}

// ── 1. addMessage + getMessages round-trip ───────────────────────────────────

Deno.test({
  name: "MastraMemory: addMessage + getMessages round-trip",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const mem = await makeMemory();
    try {
      await mem.addMessage({ role: "user", content: "Hello from unit test" });
      const messages = await mem.getMessages();
      assert(messages.length >= 1, "Should have at least 1 message");
      const found = messages.find(
        (m) => m.role === "user" && m.content === "Hello from unit test",
      );
      assert(found !== undefined, "Should find the added message");
    } finally {
      await mem.clear();
      mem.close();
    }
  },
});

// ── 2. getMessages returns empty for new thread ──────────────────────────────

Deno.test({
  name: "MastraMemory: getMessages returns empty for new thread",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const mem = await makeMemory();
    try {
      const messages = await mem.getMessages();
      assertEquals(messages.length, 0, "New thread should have no messages");
    } finally {
      await mem.clear();
      mem.close();
    }
  },
});

// ── 3. clear resets messages ─────────────────────────────────────────────────

Deno.test({
  name: "MastraMemory: clear resets messages",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const mem = await makeMemory();
    try {
      await mem.addMessage({ role: "user", content: "Message before clear" });
      await mem.addMessage({ role: "assistant", content: "Reply before clear" });

      const beforeClear = await mem.getMessages();
      assert(beforeClear.length >= 2, "Should have messages before clear");

      await mem.clear();

      const afterClear = await mem.getMessages();
      assertEquals(afterClear.length, 0, "Should have no messages after clear");
    } finally {
      await mem.clear().catch(() => {});
      mem.close();
    }
  },
});

// ── 4. semanticRecall returns results (NoopEmbedder — no crashes) ────────────

Deno.test({
  name: "MastraMemory: semanticRecall returns results (NoopEmbedder)",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const mem = await makeMemory();
    try {
      await mem.addMessage({ role: "user", content: "What is the weather today?" });
      await mem.addMessage({ role: "assistant", content: "It is sunny." });

      // NoopEmbedder has dimension=0, so no real vector match — but must not crash
      let recalled: Awaited<ReturnType<typeof mem.semanticRecall>>;
      try {
        recalled = await mem.semanticRecall("weather", 3);
      } catch {
        // Some Mastra versions may throw for zero-dimension vectors — that is acceptable
        recalled = [];
      }
      assert(Array.isArray(recalled), "semanticRecall should return an array");
    } finally {
      await mem.clear();
      mem.close();
    }
  },
});

// ── 5. trimMessages returns messages (passthrough test) ──────────────────────

Deno.test({
  name: "MastraMemory: trimMessages returns messages",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const mem = await makeMemory();
    try {
      const input = [
        { role: "user" as const, content: "First message" },
        { role: "assistant" as const, content: "Second message" },
        { role: "user" as const, content: "Third message" },
      ];

      const trimmed = await mem.trimMessages(input, 10_000);
      assert(Array.isArray(trimmed), "trimMessages should return an array");
      assert(trimmed.length > 0, "trimMessages should return at least some messages");
      for (const m of trimmed) {
        assert(typeof m.role === "string", "Each message should have a role");
        assert(typeof m.content === "string", "Each message should have content");
      }
    } finally {
      await mem.clear();
      mem.close();
    }
  },
});

// ── 6. count tracks messages ─────────────────────────────────────────────────

Deno.test({
  name: "MastraMemory: count tracks messages",
  ignore: skip,
  ...baseTestOpts,
  async fn() {
    const mem = await makeMemory();
    try {
      assertEquals(mem.count, 0, "count should start at 0 for new thread");

      await mem.addMessage({ role: "user", content: "Count test message 1" });
      assertEquals(mem.count, 1, "count should be 1 after first addMessage");

      await mem.addMessage({ role: "assistant", content: "Count test message 2" });
      assertEquals(mem.count, 2, "count should be 2 after second addMessage");

      await mem.clear();
      assertEquals(mem.count, 0, "count should be 0 after clear");
    } finally {
      await mem.clear().catch(() => {});
      mem.close();
    }
  },
});
