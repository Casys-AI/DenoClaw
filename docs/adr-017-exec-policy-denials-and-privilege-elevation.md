# ADR-017: Exec Policy Denials and Temporary Privilege Elevation

**Status:** Accepted **Date:** 2026-03-31 **Related:** ADR-005, ADR-010, ADR-016

## Context

The runtime currently contains two partially overlapping ideas:

- command-by-command execution approval
- structural sandbox privilege checks

The first came from an interactive copilot model:

- `ask: "on-miss" | "always"`
- `EXEC_APPROVAL_REQUIRED`
- `allowAlways`
- remembered command approvals

The second comes from the actual sandbox security model:

- `allowedPermissions`
- permission intersection
- sandbox network policy
- broker-controlled execution envelope

For autonomous agents, the interactive command approval model is not the right
center of gravity.

The system should not depend on an operator clicking "approve" for ordinary
command execution.

## Decision

### 1. Static policy is the primary execution model

If an action is allowed by the effective runtime policy, it should execute.

The effective runtime policy is defined by:

- broker-side sandbox policy
- `allowedPermissions`
- static `execPolicy`
- `shell.mode`
- network constraints

The normal autonomous path is therefore:

- policy allows
- execution proceeds

Not:

- policy blocks
- human approves the command itself

### 2. Command approval is not the primary security primitive

Per-command approval is deprecated as a core design pillar.

It may remain temporarily for compatibility, but it is not the target runtime
model.

In particular:

- `EXEC_APPROVAL_REQUIRED` is not the desired steady-state behavior
- `allowAlways` is not a long-term product primitive
- remembered command approvals are not the intended mechanism for autonomous
  execution

### 3. Policy denial and privilege elevation are distinct

The runtime must distinguish between:

- `EXEC_POLICY_DENIED`
- `PRIVILEGE_ELEVATION_REQUIRED`

#### `EXEC_POLICY_DENIED`

Use when the command or execution mode is blocked by the configured execution
policy.

Examples:

- binary not in allowlist
- inline eval forbidden
- `system-shell` requested under incompatible policy
- shell disabled

This is a policy/configuration denial.

It is **not** eligible for runtime approval of the command itself.

#### `PRIVILEGE_ELEVATION_REQUIRED`

Use when the command is acceptable in principle, but the current sandbox
envelope lacks required privileges.

Examples:

- missing `net`
- missing `write`
- missing `env`
- missing `ffi`

This is the place where a bounded, temporary privilege elevation may happen.

The elevation target should be as resource-scoped as practical, not just a raw
permission name.

### 4. Human intervention applies to policy elevation, not command approval

If human intervention is needed, it should approve a temporary widening of the
effective sandbox policy, not the individual command string.

The approval target becomes:

- privilege or privileges to grant
- bounded resources attached to those privileges
- scope
- duration

Not:

- raw shell command text

Examples:

- grant `net` to `api.github.com` for this task
- grant `write` to `/workspace/repo/docs` for this session
- grant `env` for `GITHUB_TOKEN` once

Examples of resource scoping:

- `net` -> allowed hosts
- `write` -> allowed path prefixes
- `read` -> allowed path prefixes
- `env` -> allowed keys
- `ffi` -> allowed libraries or bindings

For shell-oriented execution, future elevation may also rely on named broker
policy groups rather than raw command approval.

### 5. Temporary privilege elevation is broker-scoped

Any future elevation mechanism must be broker-controlled.

Agents do not self-grant privileges.

The broker remains responsible for:

- deciding whether elevation is possible
- storing temporary grants
- applying those grants to effective execution policy
- expiring or revoking them
- auditing them

The broker is also responsible for interpreting resource-scoped grants and
merging them into the effective runtime envelope.

Privilege elevation must also be explicitly enabled per agent (or by defaults
that apply to that agent).

In other words:

- the broker owns the mechanism
- agent config decides whether that mechanism is allowed for a given agent

If elevation is disabled for an agent, the broker may still return
`PRIVILEGE_ELEVATION_REQUIRED` as a structured explanation of what is missing,
but it must not open a resumable elevation flow for that agent.

### 6. The first useful scopes are `once` and `task`

Temporary privilege elevation may eventually support multiple scopes.

The first useful ones are:

- `once`
- `task`

`session` may exist later, but only once worker/session lifecycle is clearly
defined and cleaned up.

There is no `always allow` for structural privileges.

### 7. Operator UI is decoupled from the broker authority

If privilege elevation approval is exposed to a human, the approval surface is
just a UI channel.

Possible future surfaces:

- Telegram button
- admin web UI
- dashboard action
- signed API callback

In every case:

- the broker stays the source of truth
- the approval channel is only a decision surface

## Consequences

### Immediate consequences

- the runtime should prefer `EXEC_POLICY_DENIED` over command approval prompts
- `PRIVILEGE_ELEVATION_REQUIRED` remains the meaningful interactive hook
- command approval should stop expanding as a product feature
- privilege elevation support becomes part of effective agent policy, not a
  global runtime assumption

### Architectural consequences

- static policy remains the baseline autonomous execution model
- temporary grants, if added, must modify effective privileges, not whitelist
  individual commands
- privilege elevation storage and lifecycle belong in broker runtime state
- per-agent config must be able to disable elevation entirely, or constrain the
  scopes/resources it may use

### UX consequences

The operator should reason in terms of:

- "should this agent get `net` for this task?"

Not:

- "should I approve `curl https://...`?"

## Non-Goals

This ADR does not define:

- the exact storage format of temporary grants
- TTL values
- audit event schema
- the operator UI
- the migration timeline for removing all legacy command approval plumbing
- the exact first version of shell-oriented policy groups

## Rationale

This model is cleaner for autonomous systems because it aligns the runtime with
its real security boundary:

- policy and privileges are what matter
- not one-off approval of command strings

It also creates a more stable operator model:

- deny by policy
- or elevate privilege temporarily

Those are the two meaningful decisions.
