import { assertEquals } from "@std/assert";
import { SessionEntity } from "./session_entity.ts";

Deno.test("SessionEntity creates/touches sessions with deterministic fields", () => {
  const created = SessionEntity.createNew({
    id: "s-1",
    userId: "u-1",
    channelType: "cli",
    now: "2026-03-29T00:00:00.000Z",
  });

  assertEquals(created.createdAt, "2026-03-29T00:00:00.000Z");
  assertEquals(created.lastActivity, "2026-03-29T00:00:00.000Z");

  const touched = new SessionEntity(created).touch("2026-03-29T01:00:00.000Z").session;
  assertEquals(touched.lastActivity, "2026-03-29T01:00:00.000Z");
  assertEquals(touched.createdAt, "2026-03-29T00:00:00.000Z");
});
