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
  ask: "off",
  askFallback: "deny",
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
    "shell-operator",
  );
  await backend.close();
});

Deno.test("LocalProcessBackend security=deny blocks all shell", async () => {
  const denyPolicy: ExecPolicy = { security: "deny", ask: "off" };
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("echo hi", denyPolicy));
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  await backend.close();
});

Deno.test("LocalProcessBackend security=full allows everything", async () => {
  const fullPolicy: ExecPolicy = { security: "full", ask: "off" };
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

// ── Ask flow ──

Deno.test("LocalProcessBackend ask=on-miss with no callback — askFallback=deny denies", async () => {
  const policy: ExecPolicy = {
    security: "allowlist",
    allowedCommands: ["echo"],
    ask: "on-miss",
    askFallback: "deny",
  };
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute(shellReq("curl foo.com", policy));
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  await backend.close();
});

Deno.test("LocalProcessBackend ask=on-miss with callback — approved proceeds to exec", async () => {
  const policy: ExecPolicy = {
    security: "allowlist",
    allowedCommands: [],
    ask: "on-miss",
    askFallback: "deny",
  };
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute({
    ...shellReq("echo approved", policy),
    onAskApproval: () => Promise.resolve({ approved: true }),
  });
  assertEquals(result.success, true);
  assertEquals(result.output.includes("approved"), true);
  await backend.close();
});

Deno.test("LocalProcessBackend ask=on-miss with callback — denied", async () => {
  const policy: ExecPolicy = {
    security: "allowlist",
    allowedCommands: [],
    ask: "on-miss",
    askFallback: "deny",
  };
  const backend = new LocalProcessBackend(baseSandbox);
  const result = await backend.execute({
    ...shellReq("echo nope", policy),
    onAskApproval: () => Promise.resolve({ approved: false }),
  });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
  await backend.close();
});

Deno.test("LocalProcessBackend ask callback — allowAlways adds to session allowlist", async () => {
  const policy: ExecPolicy = {
    security: "allowlist",
    allowedCommands: [],
    ask: "on-miss",
    askFallback: "deny",
  };
  const backend = new LocalProcessBackend(baseSandbox);

  // First call: callback approves with allowAlways
  const r1 = await backend.execute({
    ...shellReq("echo first", policy),
    onAskApproval: () => Promise.resolve({ approved: true, allowAlways: true }),
  });
  assertEquals(r1.success, true);

  // Second call: no callback needed — "echo" is now in session allowlist
  const r2 = await backend.execute(shellReq("echo second", policy));
  assertEquals(r2.success, true);

  await backend.close();
});

Deno.test("LocalProcessBackend approval timeout — denies (fail-closed)", async () => {
  const sandbox: SandboxConfig = { ...baseSandbox, approvalTimeoutSec: 1 };
  const policy: ExecPolicy = {
    security: "allowlist",
    allowedCommands: [],
    ask: "on-miss",
    askFallback: "deny",
  };
  const backend = new LocalProcessBackend(sandbox);
  const result = await backend.execute({
    ...shellReq("echo timeout", policy),
    onAskApproval: () => new Promise(() => {}), // never resolves
  });
  assertEquals(result.success, false);
  assertEquals(result.error?.code, "EXEC_DENIED");
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
