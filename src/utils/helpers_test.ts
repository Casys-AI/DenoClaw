import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatDate, generateId, getHomeDir, truncate } from "./helpers.ts";

Deno.test("generateId returns a valid UUID", () => {
  const id = generateId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
  assertStringIncludes(id, "-");
});

Deno.test("formatDate returns ISO string", () => {
  const d = new Date("2026-03-26T12:00:00Z");
  assertEquals(formatDate(d), "2026-03-26T12:00:00.000Z");
});

Deno.test("truncate keeps short text as-is", () => {
  assertEquals(truncate("hello", 10), "hello");
});

Deno.test("truncate cuts long text with ellipsis", () => {
  assertEquals(truncate("hello world", 8), "hello...");
});

Deno.test("getHomeDir returns a path ending with .denoclaw", () => {
  assertStringIncludes(getHomeDir(), ".denoclaw");
});
