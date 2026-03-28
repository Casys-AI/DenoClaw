import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  buildWatchKeys,
  createSSEResponse,
  kvEntryToDashboardEvent,
} from "./monitoring.ts";
import type { AgentStatusValue, AgentTaskEntry } from "../shared/types.ts";

// ── buildWatchKeys ─────────────────────────────────────────

Deno.test({
  name: "buildWatchKeys — always includes dashboard sentinel keys",
  fn() {
    const keys = buildWatchKeys([]);

    // Must contain at least the two dashboard sentinels
    const flat = keys.map((k) => k.join("/"));
    assertEquals(flat.includes("_dashboard/agents_list"), true);
    assertEquals(flat.includes("_dashboard/agent_task_update"), true);
  },
});

Deno.test({
  name: "buildWatchKeys — includes status key for each agentId",
  fn() {
    const keys = buildWatchKeys(["alice", "bob"]);
    const flat = keys.map((k) => k.join("/"));

    assertEquals(flat.includes("agents/alice/status"), true);
    assertEquals(flat.includes("agents/bob/status"), true);
  },
});

Deno.test({
  name: "buildWatchKeys — total length is 2 + agentIds.length",
  fn() {
    const ids = ["a", "b", "c"];
    const keys = buildWatchKeys(ids);
    assertEquals(keys.length, 2 + ids.length);
  },
});

Deno.test({
  name: "buildWatchKeys — empty agentIds returns exactly 2 keys",
  fn() {
    const keys = buildWatchKeys([]);
    assertEquals(keys.length, 2);
  },
});

// ── kvEntryToDashboardEvent ────────────────────────────────

function makeEntry(
  key: Deno.KvKey,
  value: unknown,
): Deno.KvEntryMaybe<unknown> {
  return { key, value, versionstamp: "000" } as Deno.KvEntryMaybe<unknown>;
}

Deno.test({
  name: "kvEntryToDashboardEvent — agents_list key → agents_list_updated",
  fn() {
    const entry = makeEntry(["_dashboard", "agents_list"], ["agent-a", "agent-b"]);
    const event = kvEntryToDashboardEvent(entry);

    assertEquals(event?.type, "agents_list_updated");
    if (event?.type === "agents_list_updated") {
      assertEquals(event.agentIds, ["agent-a", "agent-b"]);
    }
  },
});

Deno.test({
  name: "kvEntryToDashboardEvent — agents_list null value → empty agentIds array",
  fn() {
    const entry: Deno.KvEntryMaybe<unknown> = {
      key: ["_dashboard", "agents_list"],
      value: null,
      versionstamp: null,
    };
    const event = kvEntryToDashboardEvent(entry);

    assertEquals(event?.type, "agents_list_updated");
    if (event?.type === "agents_list_updated") {
      assertEquals(event.agentIds, []);
    }
  },
});

Deno.test({
  name: "kvEntryToDashboardEvent — agent_task_update key with value → agent_task",
  fn() {
    const task: AgentTaskEntry = {
      id: "t1",
      from: "alice",
      to: "bob",
      message: "hello",
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const entry = makeEntry(["_dashboard", "agent_task_update"], task);
    const event = kvEntryToDashboardEvent(entry);

    assertEquals(event?.type, "agent_task");
    if (event?.type === "agent_task") {
      assertEquals(event.task, task);
    }
  },
});

Deno.test({
  name: "kvEntryToDashboardEvent — agent_task_update with null value → null",
  fn() {
    const entry: Deno.KvEntryMaybe<unknown> = {
      key: ["_dashboard", "agent_task_update"],
      value: null,
      versionstamp: null,
    };
    const event = kvEntryToDashboardEvent(entry);
    assertStrictEquals(event, null);
  },
});

Deno.test({
  name: "kvEntryToDashboardEvent — agents/<id>/status key → agent_status",
  fn() {
    const status: AgentStatusValue = {
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const entry = makeEntry(["agents", "alice", "status"], status);
    const event = kvEntryToDashboardEvent(entry);

    assertEquals(event?.type, "agent_status");
    if (event?.type === "agent_status") {
      assertEquals(event.agentId, "alice");
      assertEquals(event.status, status);
    }
  },
});

Deno.test({
  name: "kvEntryToDashboardEvent — agents/<id>/status with null value → null",
  fn() {
    const entry: Deno.KvEntryMaybe<unknown> = {
      key: ["agents", "alice", "status"],
      value: null,
      versionstamp: null,
    };
    const event = kvEntryToDashboardEvent(entry);
    assertStrictEquals(event, null);
  },
});

Deno.test({
  name: "kvEntryToDashboardEvent — unrecognized key → null",
  fn() {
    const entry = makeEntry(["some", "other", "key"], { foo: "bar" });
    const event = kvEntryToDashboardEvent(entry);
    assertStrictEquals(event, null);
  },
});

// ── createSSEResponse ──────────────────────────────────────

Deno.test({
  name: "createSSEResponse — returns Response with SSE headers",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));

    const res = createSSEResponse(kv, []);

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    assertEquals(res.headers.get("cache-control"), "no-cache");
    assertEquals(res.headers.get("connection"), "keep-alive");

    // Cancel the stream immediately to avoid resource leaks
    await res.body?.cancel();

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "createSSEResponse — body starts with snapshot event",
  async fn() {
    const kv = await Deno.openKv(await Deno.makeTempFile({ suffix: ".db" }));

    const res = createSSEResponse(kv, []);
    const reader = res.body!.getReader();

    const { value } = await reader.read();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    assertEquals(text.startsWith("data: "), true);

    const json = JSON.parse(text.replace(/^data: /, "").trim()) as {
      type: string;
    };
    assertEquals(json.type, "snapshot");

    kv.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
