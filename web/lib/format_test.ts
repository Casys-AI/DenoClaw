import { assertEquals } from "@std/assert";
import { formatRelative } from "./format.ts";

Deno.test("formatRelative returns fallback for invalid ISO strings", () => {
  assertEquals(formatRelative("not-a-date"), "—");
});

Deno.test("formatRelative handles future timestamps", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-01T00:00:00.000Z");

  try {
    assertEquals(formatRelative("2026-04-01T00:01:00.000Z"), "in 1m");
  } finally {
    Date.now = originalNow;
  }
});
