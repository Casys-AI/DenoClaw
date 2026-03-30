# ADR-005: Sandbox Permissions — Least Privilege by Intersection

**Status:** Accepted **Date:** 2026-03-27

## Context

When an agent executes a tool (shell, file, web), the broker creates an
ephemeral Sandbox. The question is: which permissions should that Sandbox
receive?

## Decision

**Tool × agent intersection.** Each tool declares the permissions it needs.
Each agent declares the maximum permissions it allows. The Sandbox receives the
intersection of the two.

## Available Permissions

| Permission | Description                | Deno flag       |
| ---------- | -------------------------- | --------------- |
| `read`     | Read files                 | `--allow-read`  |
| `write`    | Write files                | `--allow-write` |
| `run`      | Execute commands           | `--allow-run`   |
| `net`      | Network access             | `--allow-net`   |
| `env`      | Environment variables      | `--allow-env`   |
| `ffi`      | Foreign Function Interface | `--allow-ffi`   |

## Tool-Side Declaration (AX: explicit)

Each tool declares its requirements in its definition:

```typescript
class ShellTool extends BaseTool {
  name = "shell";
  permissions: SandboxPermission[] = ["run"];
}

class ReadFileTool extends BaseTool {
  name = "read_file";
  permissions: SandboxPermission[] = ["read"];
}

class WriteFileTool extends BaseTool {
  name = "write_file";
  permissions: SandboxPermission[] = ["write"];
}

class WebFetchTool extends BaseTool {
  name = "web_fetch";
  permissions: SandboxPermission[] = ["net"];
}
```

## Agent-Side Declaration (config)

Each agent has a set of maximum permissions:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-6",
      "sandbox": {
        "allowedPermissions": ["read", "write", "run", "net"],
        "networkAllow": ["api.anthropic.com", "api.openai.com"],
        "maxDurationSec": 30
      }
    }
  }
}
```

## Runtime Resolution (broker)

```
1. Agent requests: execTool("shell", { command: "ls" })
2. Broker checks:
   - Shell needs: ["run"]
   - Agent allows at most: ["read", "write", "run", "net"]
   - Intersection: ["run"]
3. Broker creates the Sandbox with: --allow-run
4. If the tool asks for a permission the agent does not allow → reject
```

## Explicit Rejection (AX: structured error)

```typescript
{
  code: "SANDBOX_PERMISSION_DENIED",
  context: {
    tool: "shell",
    required: ["run"],
    agentAllowed: ["read"],
    denied: ["run"]
  },
  recovery: "Add 'run' to agent sandbox.allowedPermissions"
}
```

## Network allowlist

In addition to Deno permissions, the Sandbox has a **network allowlist**:

- By default: only the broker is reachable
- The agent can add specific domains (LLM APIs, etc.)
- Domains are validated by the broker (no dangerous wildcards)

## End-to-End Flow

```
Agent (Deploy app)          Broker (Deploy)              Sandbox (ephemeral)
     │                           │                            │
     │ tool_request: "shell"     │                            │
     ├──────────────────────────►│                            │
     │                           │ 1. Verifies permissions    │
     │                           │    tool needs: [run]       │
     │                           │    agent allows: [run,read]│
     │                           │    → OK, intersection: [run]│
     │                           │                            │
     │                           │ 2. Creates Sandbox         │
     │                           ├───────────────────────────►│
     │                           │    --allow-run              │
     │                           │    network: [broker-url]    │
     │                           │    timeout: 30s             │
     │                           │                            │
     │                           │ 3. Executes the code       │
     │                           │                            │ ls -la
     │                           │◄───────────────────────────┤
     │                           │    result                  │
     │                           │                            │
     │                           │ 4. Destroys Sandbox        │
     │                           │           ╳                │
     │◄──────────────────────────┤
     │ tool_response             │
```

## Rationale

- **Least privilege** — the sandbox never gets more than necessary
- **AX: explicit** — each tool declares its needs; there are no implicit
  permissions
- **Defense in depth** — even if a tool is compromised, it cannot exceed its
  declared permissions
- **Configurable per agent** — a "read-only" agent can forbid `run` and `write`
- **Structured errors** — the rejection explains what is missing and how to fix
  it

## Consequences

- Every `BaseTool` must declare a `permissions` field
- The `Config` type must include `sandbox.allowedPermissions` in agent config
- The broker must calculate the intersection and pass it to the Sandbox API
- A tool that forgets to declare its permissions → denied by default (AX safe
  default)
