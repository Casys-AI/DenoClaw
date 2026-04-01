import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  AgentStore,
  createAgentConfigKey,
  createLegacyAgentConfigKey,
} from "./agent_store.ts";
import type { AgentEntry } from "../shared/types.ts";

const AGENT_A: AgentEntry = {
  model: "claude-3-5-haiku-20241022",
  systemPrompt: "You are agent A",
  description: "Test agent A",
};

const AGENT_B: AgentEntry = {
  model: "gpt-4o-mini",
  systemPrompt: "You are agent B",
};

// ── get / set ──────────────────────────────────────────────

Deno.test({
  name: "AgentStore.get — returns null for unknown agent",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    const result = await store.get("nonexistent");
    assertStrictEquals(result, null);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.set + get — round-trip",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await store.set("agent-a", AGENT_A);
    const result = await store.get("agent-a");

    assertEquals(result, AGENT_A);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.set — overwrites existing entry",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await store.set("agent-a", AGENT_A);
    const updated: AgentEntry = { ...AGENT_A, model: "claude-opus-4-5" };
    await store.set("agent-a", updated);

    const result = await store.get("agent-a");
    assertEquals(result?.model, "claude-opus-4-5");

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.get — falls back to legacy config namespace",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await kv.set(createLegacyAgentConfigKey("agent-a"), AGENT_A);

    const result = await store.get("agent-a");
    assertEquals(result, AGENT_A);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.getEntry — returns canonical key before legacy key",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await kv.set(createLegacyAgentConfigKey("agent-a"), AGENT_A);
    await kv.set(createAgentConfigKey("agent-a"), AGENT_B);

    const entry = await store.getEntry("agent-a");

    assertEquals(entry.key, createAgentConfigKey("agent-a"));
    assertEquals(entry.value, AGENT_B);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── list ───────────────────────────────────────────────────

Deno.test({
  name: "AgentStore.list — empty store returns empty record",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    const result = await store.list();
    assertEquals(Object.keys(result).length, 0);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.list — returns all stored agents",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await store.set("agent-a", AGENT_A);
    await store.set("agent-b", AGENT_B);

    const result = await store.list();
    assertEquals(Object.keys(result).length, 2);
    assertEquals(result["agent-a"], AGENT_A);
    assertEquals(result["agent-b"], AGENT_B);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "AgentStore.list — includes legacy entries only when canonical key is absent",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await kv.set(createLegacyAgentConfigKey("agent-a"), AGENT_A);
    await kv.set(createLegacyAgentConfigKey("agent-b"), AGENT_A);
    await kv.set(createAgentConfigKey("agent-b"), AGENT_B);

    const result = await store.list();

    assertEquals(result["agent-a"], AGENT_A);
    assertEquals(result["agent-b"], AGENT_B);
    assertEquals(Object.keys(result).length, 2);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── delete ─────────────────────────────────────────────────

Deno.test({
  name: "AgentStore.delete — returns false for unknown agent",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    const deleted = await store.delete("nonexistent");
    assertStrictEquals(deleted, false);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.delete — removes agent and returns true",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await store.set("agent-a", AGENT_A);
    const deleted = await store.delete("agent-a");
    assertStrictEquals(deleted, true);

    const result = await store.get("agent-a");
    assertStrictEquals(result, null);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.delete — removes both canonical and legacy keys",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await kv.set(createAgentConfigKey("agent-a"), AGENT_A);
    await kv.set(createLegacyAgentConfigKey("agent-a"), AGENT_A);

    const deleted = await store.delete("agent-a");

    assertStrictEquals(deleted, true);
    assertStrictEquals(
      (await kv.get<AgentEntry>(createAgentConfigKey("agent-a"))).value,
      null,
    );
    assertStrictEquals(
      (await kv.get<AgentEntry>(createLegacyAgentConfigKey("agent-a"))).value,
      null,
    );

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.delete — does not affect other agents",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    await store.set("agent-a", AGENT_A);
    await store.set("agent-b", AGENT_B);
    await store.delete("agent-a");

    const remaining = await store.list();
    assertEquals(Object.keys(remaining).length, 1);
    assertEquals(remaining["agent-b"], AGENT_B);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ── importAll ──────────────────────────────────────────────

Deno.test({
  name: "AgentStore.importAll — imports all entries and returns count",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    const count = await store.importAll({
      "agent-a": AGENT_A,
      "agent-b": AGENT_B,
    });
    assertEquals(count, 2);

    const list = await store.list();
    assertEquals(Object.keys(list).length, 2);
    assertEquals(list["agent-a"], AGENT_A);
    assertEquals(list["agent-b"], AGENT_B);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentStore.importAll — empty registry returns 0",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));
    const store = new AgentStore(kv);

    const count = await store.importAll({});
    assertEquals(count, 0);

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
