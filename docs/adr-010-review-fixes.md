# ADR-010 — Review Fixes

> Historical review notes for the older command-approval model that existed
> around ADR-010. The live runtime now uses policy-first execution plus
> broker-owned privilege elevation.

**Date:** 2026-03-27 **Source:** Cross-review by 5 agents (code reviewer, silent
failure hunter, type design, test coverage, architecture)

## Critical issues (must fix)

### Fix 1 — `ask: "always"` never triggers

**File:** `src/agent/tools/shell.ts` (`checkExecPolicy`) +
`src/agent/tools/backends/local.ts` (`enforceExecPolicy`) **Problem:**
`checkExecPolicy` returns `{ allowed: true }` for commands already in the
allowlist. `enforceExecPolicy` only enters the approval flow when
`check.allowed === false`. As a result, `ask: "always"` is silently ignored for
approved commands. **Fix:** add a final check in `checkExecPolicy`: if
`policy.ask === "always"`, return
`{ allowed: false, reason: "always-ask", binary }` so the approval path is
forced.

### Fix 2 — `allowedCommands: []` allows everything instead of blocking everything

**File:** `src/agent/tools/shell.ts:54` **Problem:**
`if (allowed.length > 0 && !allowed.includes(binary))` becomes false when the
list is empty, so everything is allowed. `DEFAULT_EXEC_POLICY` uses
`allowedCommands: []`, which makes the default effectively permissive. **Fix:**
change the condition to `if (!allowed.includes(binary))` so an empty list means
deny-all. That matches AX #2 Safe Defaults.

### Fix 3 — `initPromise` poisoned after cloud init failure

**File:** `src/agent/tools/backends/cloud.ts` (`ensureInitialized`) **Problem:**
if `init()` throws, `initPromise` keeps pointing to a rejected promise forever.
Every later call fails with the same error. No retry is possible. **Fix:** clear
`initPromise` in the catch block and log the error. Also clean up the VM when
`Sandbox.create()` succeeds but `fs.upload()` fails, otherwise the VM is
orphaned.

### Fix 4 — `askPending` in the worker has no timeout, so the promise can hang forever

**File:** `src/agent/worker_entrypoint.ts` (`askApproval`) **Problem:** the
promise only has `resolve`, with no `reject` and no timeout. If `WorkerPool`
never returns `ask_response`, the promise hangs forever and the worker becomes a
zombie. **Fix:** add timeout + reject in `askApproval()` (symmetric to
`sendToAgent`, which already has a timeout), and drain `askPending` during
shutdown.

### Fix 5 — `approvalTimeout` timer is never cleared

**File:** `src/agent/tools/backends/local.ts` (`enforceExecPolicy`,
`Promise.race`) **Problem:** when approval arrives before timeout, the
`setTimeout` from `approvalTimeout()` is never cleared. That leaks one timer per
approval request. **Fix:** keep a cancellable timer handle and `clearTimeout` it
in a `finally` block after `Promise.race`. Also distinguish timeout vs crash in
the catch block (`warn` for timeout, `error` for everything else).

### Fix 6 — cloud backend has no timeout around `sandbox.sh`

**File:** `src/agent/tools/backends/cloud.ts` (`execute`) **Problem:**
`timeoutSec` is computed but never used. `sandbox.sh` can hang forever, which
blocks the worker and leaves the VM alive indefinitely. **Fix:** wrap
`sandbox.sh` in `Promise.race` with a timeout. The existing catch can then
convert the failure into `SANDBOX_EXEC_ERROR`.

### Fix 7 — `close()` cascade breaks if `backend.close()` throws

**File:** `src/agent/tools/registry.ts` (`close`) **Problem:** if
`backend.close()` throws, for example because `sandbox.kill()` hits a network
timeout, the exception propagates and `memory.close()` in `loop.ts` never runs.
**Fix:** add try/catch inside `registry.close()`, log the error, and never
rethrow.

### Fix 8 — `handleAskApproval` is async but not awaited, causing unhandled rejection

**File:** `src/agent/worker_pool.ts:200-202` **Problem:**
`this.handleAskApproval(fromAgentId, msg)` is async, but the call site uses
neither `await` nor `.catch()`. If `postMessage` throws, for example because the
worker already terminated, the process can crash with an unhandled rejection.
**Fix:** attach `.catch(e => log.error(...))` at the call site.

### Fix 9 — `networkAllow` is always `undefined` in `registry.ts:105`

**File:** `src/agent/tools/registry.ts` (`execute`) **Problem:** the
`SandboxExecRequest` is built with `networkAllow: undefined`. Sandbox config has
`networkAllow`, but it is never passed to the backend. If `net` is granted, the
subprocess starts without any network restriction. **Fix:** store `networkAllow`
inside `ToolRegistry` through `setBackend()` and pass it on each `execute()`
call.

### Fix 10 — `factory.ts` throws `new Error(JSON.stringify(...))` instead of `DenoClawError`

**File:** `src/agent/tools/backends/factory.ts:19` **Problem:** the structured
payload is serialized into the message string of a raw `Error`. Callers cannot
inspect `.code` or `.context`, which violates the project's structured-error
pattern. **Fix:**
`throw new ToolError("SANDBOX_UNAVAILABLE", { backend: "cloud", reason: "DENO_DEPLOY_ORG_TOKEN not set" }, "Set DENO_DEPLOY_ORG_TOKEN or use backend: 'local'")`.

---

## Design issues (to discuss)

### Design 1 — `envFilter` in `ExecPolicy` is dead code

The field exists in the type, but `filterEnv()` in `shell.ts` uses a hardcoded
`DENIED_ENV_PREFIXES`. `policy.envFilter` is never read. **Options:** wire
`envFilter` into `filterEnv()`, or remove the field.

### Design 2 — `SandboxExecResult` duplicates `ToolResult`

The shapes are identical (`success`, `output`, `error?`). The cast
`JSON.parse(out) as SandboxExecResult` silently casts to the same structure.
**Options:** define `type SandboxExecResult = ToolResult`, or keep them separate
if divergence is expected later.

### Design 3 — `ask_approval.reason` is `string` in the protocol

`WorkerResponse.ask_approval.reason` is `string`, but `ApprovalRequest.reason`
is a typed union. That is a type divergence on a security-sensitive path.
**Options:** align the type in `worker_protocol.ts`.

### Design 4 — cloud backend ignores `req.execPolicy` entirely

An agent configured with `security: "deny"` can still execute in the cloud
backend. The ADR says cloud enforcement is optional, but `security: "deny"`
should at least be honored. **Options:** honor `security: "deny"` in cloud, even
if the rest of the policy remains ignored because the VM already isolates.

### Design 5 — cloud backend `--allow-all` ignores ADR-005 permission intersection

Permissions arrive in `req.permissions`, but the subprocess inside the VM still
runs with `--allow-all`. **Options:** accept this because the VM is isolated,
but document it explicitly, or also apply Deno permission flags inside the VM.

### Design 6 — `filterEnv` strips `PATH`, so binaries stop resolving

Without `PATH`, `Deno.Command("git", [...])` cannot resolve `git`. Commands then
fail with `COMMAND_EXEC_ERROR` without a clear explanation. **Applied fix:**
remove `PATH` from the denied prefixes. `DENIED_ENV_PREFIXES` is now
`["LD_", "DYLD_"]`, so only dynamic-library injection variables are blocked.

### Design 7 — `ExecPolicy` should be a discriminated union

`security: "deny"` with `allowedCommands: ["git"]` is structurally valid but
semantically inconsistent. A discriminated union would prevent this shape.
**Options:** make `security` the discriminator, or validate the config at
construction time.

### Design 8 — missing `strictInlineEval` means `true`, which is inverted

The field is `boolean | undefined`, but the default resolves to `true` because
the code checks `!== false`. That is counterintuitive. **Options:** rename the
field to `allowInlineEval?: boolean` so missing means `false`, which preserves
strict mode by default.

### Design 9 — `supportsFullShell` was decorative

The flag existed on `SandboxBackend`, but no code branched on it. It described
an execution mode the runtime did not actually implement, so it was removed.

### Design 10 — `deniedCommands` uses `string.includes()`, which creates false positives

`command.includes("rm")` also matches `echo "rm is dangerous"`. That creates
argument-level false positives. **Options:** match against the binary (first
word) instead of the whole command string.
