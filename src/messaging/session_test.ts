import { assertEquals } from "@std/assert";
import { SessionManager } from "./session.ts";

Deno.test({
  name: "SessionManager creates and retrieves sessions",
  async fn() {
    const sm = new SessionManager();
    const session = await sm.getOrCreate("test-1", "user-a", "console");

    assertEquals(session.id, "test-1");
    assertEquals(session.userId, "user-a");
    assertEquals(session.channelType, "console");

    const retrieved = await sm.get("test-1");
    assertEquals(retrieved?.id, "test-1");

    sm.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SessionManager updates lastActivity on re-access",
  async fn() {
    const sm = new SessionManager();
    const first = await sm.getOrCreate("test-2", "user-b", "webhook");
    const firstActivity = first.lastActivity;

    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 10));
    const second = await sm.getOrCreate("test-2", "user-b", "webhook");

    assertEquals(second.id, "test-2");
    assertEquals(second.lastActivity >= firstActivity, true);

    sm.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SessionManager deletes sessions",
  async fn() {
    const sm = new SessionManager();
    await sm.getOrCreate("test-del", "user-c", "cli");

    await sm.delete("test-del");
    const gone = await sm.get("test-del");
    assertEquals(gone, null);

    sm.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SessionManager lists all sessions",
  async fn() {
    const sm = new SessionManager();
    await sm.getOrCreate("list-1", "user-d", "console");
    await sm.getOrCreate("list-2", "user-e", "webhook");

    const all = await sm.listAll();
    const ids = all.map((s) => s.id);
    assertEquals(ids.includes("list-1"), true);
    assertEquals(ids.includes("list-2"), true);

    sm.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
