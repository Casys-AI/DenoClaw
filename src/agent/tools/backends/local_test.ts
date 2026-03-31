import { assertEquals } from "@std/assert";
import { LocalProcessBackend } from "./local.ts";
import type {
  ExecPolicy,
  SandboxConfig,
  SandboxExecRequest,
} from "../../../shared/types.ts";

// ── Helpers ──

const baseSandbox: SandboxConfig = {
  allowedPermissions: ["read", "write", "run", "net"],
  maxDurationSec: 10,
};

const allowlistPolicy: ExecPolicy = {
  security: "allowlist",
  allowedCommands: ["echo", "ls"],
};

function shellReq(
  command: string,
  policy: ExecPolicy = allowlistPolicy,
  overrides?: Partial<SandboxExecRequest>,
): SandboxExecRequest {
  return {
    tool: "shell",
    args: { command, dry_run: false },
    permissions: ["run"],
    execPolicy: policy,
    ...overrides,
  };
}

function readFileReq(): SandboxExecRequest {
  return {
    tool: "read_file",
    args: { path: "/dev/null" },
    permissions: ["read"],
    execPolicy: allowlistPolicy,
  };
}

// ── Permission intersection (ADR-005) ──

Deno.test("LocalProcessBackend denies when permission not allowed", async () => {
  const sandbox: SandboxConfig = {
    allowedPermissions: ["read"],
    maxDurationSec: 5,
  };
  const backend = new LocalProcessBackend(sandbox);
  const result = await backend.execute(shellReq("echo hi"));
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "SANDBOX_PERMISSION_DENIED");
  assertEquals((result.error?.context as Record<string, unknown>)?.denied, [
    "run",
  ]);
  await backend.close();
});

Deno.test("LocalProcessBackend grants when permission matches", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(readFileReq());
  assertEquals(result.success, true);
  await backend.close();
});

Deno.test("LocalProcessBackend partial permission — denies missing", async () => {
  const sandbox: SandboxConfig = {
    allowedPermissions: ["run"],
    maxDurationSec: 5,
  };
  const backend = new LocalProcessBackend(sandbox);
  const result = await backend.execute({
    tool: "web_fetch",
    args: { url: "https://example.com" },
    permissions: ["net"],
    execPolicy: allowlistPolicy,
  });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "SANDBOX_PERMISSION_DENIED");
  await backend.close();
});

// ── Exec policy enforcement ──

Deno.test("LocalProcessBackend allows shell command in allowlist", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("echo hello"));
  assertEquals(result.success, true);
  await backend.close();
});

Deno.test("LocalProcessBackend denies shell command not in allowlist", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("curl evil.com"));
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  assertEquals(
    (result.error?.context as Record<string, unknown>)?.reason,
    "not-in-allowlist",
  );
  await backend.close();
});

Deno.test("LocalProcessBackend denies shell operators", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("echo hi && curl evil.com"));
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  assertEquals(
    (result.error?.context as Record<string, unknown>)?.reason,
    "unsupported-shell-syntax",
  );
  await backend.close();
});

Deno.test("LocalProcessBackend security=deny blocks all shell", async () => {
  const denyPolicy: ExecPolicy = { security: "deny" };
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("echo hi", denyPolicy));
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  await backend.close();
});

Deno.test("LocalProcessBackend security=full allows everything", async () => {
  const fullPolicy: ExecPolicy = { security: "full" };
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("echo hello", fullPolicy));
  assertEquals(result.success, true);
  await backend.close();
});

Deno.test("LocalProcessBackend skips exec policy for non-shell tools", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(readFileReq());
  assertEquals(result.success, true);
  await backend.close();
});

Deno.test("LocalProcessBackend skips exec policy for dry_run shell", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute({
    tool: "shell",
    args: { command: "curl evil.com", dry_run: true },
    permissions: ["run"],
    execPolicy: allowlistPolicy,
  });
  assertEquals(result.success, true); // dry_run passes through to executor
  await backend.close();
});

// ── close() ──

Deno.test("LocalProcessBackend uses current Deno executable even when PATH lacks deno", async () => {
  const originalPath = Deno.env.get("PATH");
  Deno.env.set("PATH", "/definitely-missing-deno");

  try {
    const backend = new LocalProcessBackend(baseSandbox);
    const result = await backend.execute(readFileReq());
    assertEquals(result.success, true);
    await backend.close();
  } finally {
    if (originalPath === undefined) {
      Deno.env.delete("PATH");
    } else {
      Deno.env.set("PATH", originalPath);
    }
  }
});

Deno.test("LocalProcessBackend close is no-op", async () => {
  const backend = new LocalProcessBackend(baseSandbox);
  await backend.close(); // should not throw
});
