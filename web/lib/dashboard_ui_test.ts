import { assertEquals } from "@std/assert";
import {
  buildA2AFilterHref,
  isNavItemActive,
  parseApiErrorText,
} from "./dashboard_ui.ts";

Deno.test("isNavItemActive treats root as overview", () => {
  assertEquals(isNavItemActive("/", "overview"), true);
  assertEquals(isNavItemActive("/", "agents"), false);
});

Deno.test("isNavItemActive matches nested dashboard paths", () => {
  assertEquals(isNavItemActive("/agents/alice", "agents"), true);
  assertEquals(isNavItemActive("/tunnels/remote-1", "tunnels"), true);
});

Deno.test("buildA2AFilterHref preserves both status and search query", () => {
  assertEquals(
    buildA2AFilterHref("running", "hello world"),
    "?status=running&q=hello+world",
  );
});

Deno.test("parseApiErrorText extracts nested API error context messages", () => {
  assertEquals(
    parseApiErrorText(JSON.stringify({
      error: {
        code: "BROKER_ERROR",
        context: { message: "Agent already exists" },
        recovery: "Try a different agent id.",
      },
    })),
    "Agent already exists",
  );
});

Deno.test("parseApiErrorText falls back to plain text", () => {
  assertEquals(parseApiErrorText("Something failed"), "Something failed");
});
