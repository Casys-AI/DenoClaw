import { assertEquals } from "@std/assert";
import { SessionManager } from "./session.ts";

async function withTempSessionManager(
  fn: (sm: SessionManager) => Promise<void>,
): Promise<void> {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const sm = new SessionManager(kv);
  try {
    await fn(sm);
  } finally {
    sm.close();
    try {
      await Deno.remove(kvPath);
    } catch {
      /* ignore */
    }
  }
}

Deno.test({
  name: "SessionManager creates and retrieves sessions",
  async fn() {
    await withTempSessionManager(async (sm) => {
      const session = await sm.getOrCreate("test-1", "user-a", "console");

      assertEquals(session.id, "test-1");
      assertEquals(session.userId, "user-a");
      assertEquals(session.channelType, "console");

      const retrieved = await sm.get("test-1");
      assertEquals(retrieved?.id, "test-1");
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SessionManager updates lastActivity on re-access",
  async fn() {
    await withTempSessionManager(async (sm) => {
      const first = await sm.getOrCreate("test-2", "user-b", "webhook");
      const firstActivity = first.lastActivity;

      await new Promise((r) => setTimeout(r, 10));
      const second = await sm.getOrCreate("test-2", "user-b", "webhook");

      assertEquals(second.id, "test-2");
      assertEquals(second.lastActivity >= firstActivity, true);
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SessionManager deletes sessions",
  async fn() {
    await withTempSessionManager(async (sm) => {
      await sm.getOrCreate("test-del", "user-c", "cli");

      await sm.delete("test-del");
      const gone = await sm.get("test-del");
      assertEquals(gone, null);
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SessionManager lists all sessions",
  async fn() {
    await withTempSessionManager(async (sm) => {
      await sm.getOrCreate("list-1", "user-d", "console");
      await sm.getOrCreate("list-2", "user-e", "webhook");

      const all = await sm.listAll();
      const ids = all.map((s) => s.id);
      assertEquals(ids.includes("list-1"), true);
      assertEquals(ids.includes("list-2"), true);
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
