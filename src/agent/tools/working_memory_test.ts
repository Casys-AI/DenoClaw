/**
 * Colocated unit tests for WorkingMemoryTool.
 *
 * Uses a mock WorkingMemoryPort — no database required.
 * Run: deno test --allow-all src/agent/tools/working_memory_test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { WorkingMemoryTool } from "./working_memory.ts";
import type { WorkingMemoryPort } from "./working_memory.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPort(initialMemory = "# Memory\n- Name: Test"): {
  port: WorkingMemoryPort;
  getLastUpdate: () => string | undefined;
} {
  let stored = initialMemory;
  let lastUpdate: string | undefined;

  const port: WorkingMemoryPort = {
    getWorkingMemory: () => Promise.resolve(stored),
    updateWorkingMemory: (content: string) => {
      lastUpdate = content;
      stored = content;
      return Promise.resolve();
    },
  };

  return { port, getLastUpdate: () => lastUpdate };
}

// ── 1. read action returns current memory ────────────────────────────────────

Deno.test({
  name: "working_memory: read action returns current memory",
  async fn() {
    const { port } = makeMockPort("# Memory\n- Name: Test");
    const tool = new WorkingMemoryTool(port);

    const result = await tool.execute({ action: "read" });

    assert(result.success, "read should succeed");
    assert(
      result.output.includes("# Memory"),
      `output should contain memory content, got: ${result.output}`,
    );
    assert(
      result.output.includes("Name: Test"),
      `output should contain 'Name: Test', got: ${result.output}`,
    );
  },
});

// ── 2. update action persists content ────────────────────────────────────────

Deno.test({
  name: "working_memory: update action persists content",
  async fn() {
    const { port, getLastUpdate } = makeMockPort();
    const tool = new WorkingMemoryTool(port);
    const newContent = "# Updated\n- key: value";

    const result = await tool.execute({ action: "update", content: newContent });

    assert(result.success, "update should succeed");
    assertEquals(
      getLastUpdate(),
      newContent,
      "updateWorkingMemory should have been called with the new content",
    );

    // Verify the stored value is now the new content
    const readResult = await tool.execute({ action: "read" });
    assert(readResult.success, "subsequent read should succeed");
    assert(
      readResult.output.includes("# Updated"),
      `read after update should return new content, got: ${readResult.output}`,
    );
  },
});

// ── 3. update without content fails ─────────────────────────────────────────

Deno.test({
  name: "working_memory: update without content fails",
  async fn() {
    const { port } = makeMockPort();
    const tool = new WorkingMemoryTool(port);

    const result = await tool.execute({ action: "update" });

    assert(!result.success, "update without content should fail");
    assert(result.error !== undefined, "error should be set");
    assertEquals(result.error?.code, "MISSING_CONTENT");
  },
});

// ── 4. unknown action fails ──────────────────────────────────────────────────

Deno.test({
  name: "working_memory: unknown action fails",
  async fn() {
    const { port } = makeMockPort();
    const tool = new WorkingMemoryTool(port);

    const result = await tool.execute({ action: "delete" });

    assert(!result.success, "unknown action should fail");
    assert(result.error !== undefined, "error should be set");
    assertEquals(result.error?.code, "UNKNOWN_ACTION");
  },
});
