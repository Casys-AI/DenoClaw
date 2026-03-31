# 2026-03-31 — Agent runtime capabilities design sketch

## Goal

Give agents enough visibility to plan correctly without making them the source
of truth for effective sandbox policy.

## Design Principles

### 1. Broker owns effective policy

The broker remains authoritative for:

- structural sandbox permissions
- network policy
- exec policy
- runtime approvals and grants
- sandbox selection and lifecycle

Agents must not become the authority that decides what is really allowed.

### 2. Agents receive a projection, not the full policy engine

Agents should receive a read-only runtime view of what they can reasonably
expect to do.

This is not the broker's full internal policy model.

### 3. Runtime capabilities are for planning

The purpose of runtime capabilities is to help the agent:

- choose tools
- avoid obviously forbidden actions
- understand whether approval may be needed
- recover when a request is denied

They are not meant to replace broker-side enforcement.

### 4. Grants are separate from base capabilities

Base capabilities and temporary approvals should not be conflated.

Examples:

- base capability: `shell` available, `run` allowed
- temporary grant: `git` approved for this task

## Proposed Model

### Broker-owned source model

The broker keeps the real policy inputs:

- agent config sandbox block
- exec policy
- network allowlist
- structural sandbox permissions
- active approval grants
- future privilege elevation grants

### Agent-facing projection

Introduce a read-only object such as `AgentRuntimeCapabilities`.

Suggested shape:

```ts
interface AgentRuntimeCapabilities {
  version: string;
  tools: {
    shell?: {
      enabled: boolean;
      execMode: "unknown" | "disabled" | "direct" | "system-shell";
      policyMode: "unknown" | "deny" | "allowlist" | "full";
      approval: {
        supported: boolean;
        scopes: Array<"once" | "task" | "session">;
      };
    };
    readFile?: { enabled: boolean };
    writeFile?: { enabled: boolean };
    webFetch?: { enabled: boolean };
    sendToAgent?: { enabled: boolean };
  };
  sandbox: {
    permissions: Array<"read" | "write" | "run" | "net" | "env" | "ffi">;
    network: {
      enabled: boolean;
      mode: "none" | "restricted" | "open";
    };
    privilegeElevation: {
      supported: boolean;
      scopes: Array<"task" | "session">;
    };
  };
}
```

This is intentionally a projection:

- enough for planning
- not coupled to internal broker plumbing
- stable enough to expose to models and tooling

## Important Separation

### `AgentRuntimeCapabilities`

Stable runtime planning surface.

Used by the agent to answer questions like:

- can I use shell at all?
- should I expect approval flows?
- do I have any network capability?

### `PrivilegeElevationGrant`

Future stronger mechanism for structural privilege changes.

This remains broker-owned and is the canonical temporary authorization model.

## Injection Strategy

### Local worker mode

Inject capabilities during worker init, alongside existing runtime config.

This keeps the worker informed without making it the policy source of truth.

### Broker-backed runtime

Inject capabilities into the agent runtime context at task/session start.

The runtime should treat them as advisory planning metadata, while broker errors
remain authoritative.

## Versioning

Capabilities should carry a `version` or fingerprint.

Why:

- approvals can change runtime behavior
- future privilege elevation could update effective capabilities
- agent sessions may otherwise reason on stale assumptions

Broker errors may later include a capability version or mismatch hint to help
the agent refresh its planning view.

## Error Model

The current distinction should become sharper:

- `EXEC_APPROVAL_REQUIRED`
- `EXEC_DENIED`
- `SANDBOX_PERMISSION_DENIED`
- future: `PRIVILEGE_ELEVATION_REQUIRED`

The agent should use:

- capabilities to plan
- structured broker errors to recover

## Non-Goals

- exposing raw sandbox provider details to the agent
- letting agents choose sandbox ownership/lifecycle
- making agents directly manage volumes or snapshots
- letting conversational approval permanently change structural privileges

## Recommended Near-Term Slice

1. Add `AgentRuntimeCapabilities` as a projection type.
2. Inject it into worker/runtime initialization.
3. Add a compact runtime summary to the planning context.
4. Keep broker-side enforcement unchanged.
5. Later separate command approvals from privilege elevation in broker errors.
