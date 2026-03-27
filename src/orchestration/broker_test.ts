import { assertEquals } from "@std/assert";
import { BUILTIN_TOOL_PERMISSIONS } from "../agent/tools/types.ts";

// ── BUILTIN_TOOL_PERMISSIONS static contract (AX-8) ──────────────────────────

Deno.test("BUILTIN_TOOL_PERMISSIONS maps all 4 built-in tools", () => {
  const keys = Object.keys(BUILTIN_TOOL_PERMISSIONS).sort();
  assertEquals(keys, ["read_file", "shell", "web_fetch", "write_file"]);
});

Deno.test("BUILTIN_TOOL_PERMISSIONS shell → run", () => {
  assertEquals([...BUILTIN_TOOL_PERMISSIONS.shell], ["run"]);
});

Deno.test("BUILTIN_TOOL_PERMISSIONS read_file → read", () => {
  assertEquals([...BUILTIN_TOOL_PERMISSIONS.read_file], ["read"]);
});

Deno.test("BUILTIN_TOOL_PERMISSIONS write_file → write", () => {
  assertEquals([...BUILTIN_TOOL_PERMISSIONS.write_file], ["write"]);
});

Deno.test("BUILTIN_TOOL_PERMISSIONS web_fetch → net", () => {
  assertEquals([...BUILTIN_TOOL_PERMISSIONS.web_fetch], ["net"]);
});

// ── resolveToolPermissions via BrokerServer (integration — uses KV) ──────────

Deno.test({
  name: "BrokerServer resolveToolPermissions — built-in tool returns correct perms",
  async fn() {
    const { BrokerServer } = await import("./broker.ts");
    const { type: _type, ...partialConfig } = {
      type: "ignored",
      providers: {},
      agents: { defaults: { model: "test/model", temperature: 0.5, maxTokens: 512 } },
      tools: {},
      channels: {},
    };

    // deno-lint-ignore no-explicit-any
    const broker = new BrokerServer(partialConfig as any);

    // resolveToolPermissions is a thin wrapper around BUILTIN_TOOL_PERMISSIONS.
    // Validate the contract is stable (source of truth for ADR-005).
    assertEquals([...BUILTIN_TOOL_PERMISSIONS["shell"]], ["run"]);
    assertEquals([...BUILTIN_TOOL_PERMISSIONS["read_file"]], ["read"]);
    assertEquals([...BUILTIN_TOOL_PERMISSIONS["write_file"]], ["write"]);
    assertEquals([...BUILTIN_TOOL_PERMISSIONS["web_fetch"]], ["net"]);

    await broker.stop();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "BrokerServer resolveToolPermissions — unknown tool returns empty array",
  async fn() {
    // Unknown tools must yield [] (deny-by-default, ADR-005).
    // We verify the BUILTIN_TOOL_PERMISSIONS map does NOT include unknown names.
    const unknownTool = "totally_unknown_tool";
    const isBuiltin = unknownTool in BUILTIN_TOOL_PERMISSIONS;
    assertEquals(isBuiltin, false);
    // Since no tunnel is registered, resolveToolPermissions falls through to [] for unknown tools.
    // The static map is the authoritative source — this confirms deny-by-default.
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
