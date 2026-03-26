import { assertEquals, assertStringIncludes } from "@std/assert";
import { ShellTool } from "./shell.ts";

const shell = new ShellTool();

Deno.test("ShellTool dry_run by default", async () => {
  const result = await shell.execute({ command: "echo hello" });
  assertEquals(result.success, true);
  assertStringIncludes(result.output, "[dry_run]");
  assertStringIncludes(result.output, "echo hello");
});

Deno.test("ShellTool executes with dry_run=false", async () => {
  const result = await shell.execute({ command: "echo hello", dry_run: false });
  assertEquals(result.success, true);
  assertStringIncludes(result.output, "hello");
});

Deno.test("ShellTool fails on missing command", async () => {
  const result = await shell.execute({});
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "MISSING_ARG");
});

Deno.test("ShellTool denied commands", async () => {
  const restricted = new ShellTool(false, undefined, ["rm"]);
  const result = await restricted.execute({ command: "rm -rf /", dry_run: false });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "COMMAND_DENIED");
});

Deno.test("ShellTool allowed commands filter", async () => {
  const restricted = new ShellTool(false, ["echo", "ls"]);
  const result = await restricted.execute({ command: "curl evil.com", dry_run: false });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "COMMAND_NOT_ALLOWED");
});
