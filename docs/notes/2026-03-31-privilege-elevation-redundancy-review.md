# 2026-03-31 — Privilege elevation redundancy review

## Context

We introduced an agent-facing distinction between:

- `EXEC_APPROVAL_REQUIRED`
- `PRIVILEGE_ELEVATION_REQUIRED`

This is useful semantically because these two failures do not mean the same
thing:

- command approval: the action fits inside the current sandbox envelope, but
  needs an execution approval
- privilege elevation: the current sandbox envelope itself is insufficient

At the same time, the current runtime model is already strongly broker-governed:

- broker-side sandbox policy is the source of truth
- structural permissions are configured statically
- agents do not provision their own sandbox envelope
- backend permission checks are already enforced before execution

That makes a second runtime approval track for structural privilege elevation
look redundant for now.

## Reassessment

The semantic distinction is useful.

The double workflow is not.

We should keep the agent-facing error taxonomy, but avoid introducing a second
approval/grant mechanism unless a concrete use case proves that static policy is
insufficient.

## Decision Direction

For now:

- keep `PRIVILEGE_ELEVATION_REQUIRED` as a descriptive runtime error
- keep `allowAlways` and similar scoped approvals only for command execution
  inside an already-authorized envelope
- do not introduce a separate conversational or runtime privilege-elevation
  grant flow

In other words:

- command approvals may be dynamic
- structural sandbox permissions remain broker/config governed

## Why This Is Cleaner

### 1. Single effective security authority

Broker policy already decides:

- which structural permissions an agent has
- what sandbox envelope gets created
- whether execution is allowed

Adding a second runtime privilege-elevation workflow would split authority
between:

- configuration and broker policy
- interactive elevation state

That increases ambiguity without solving a demonstrated need.

### 2. Less conceptual overlap with `allowAlways`

`allowAlways` already provides a scoped, user-approved memory for command
execution decisions.

If we also add a temporary structural privilege elevation workflow, we create
two very similar runtime concepts:

- "remember this command approval"
- "remember this temporary privilege escalation"

That is harder to explain to users and harder to reason about for agents.

### 3. Stronger default posture

For structural permissions such as:

- `read`
- `write`
- `run`
- `net`
- `env`
- `ffi`

the safest default remains:

- configured explicitly
- enforced centrally
- changed administratively

That is already a strong and understandable model.

### 4. Fewer lifecycle and audit problems

A separate elevation system would immediately require clear answers for:

- TTL
- scope
- audit trail
- revocation
- interaction with worker sessions
- interaction with sandbox reuse

If we do not need that yet, we should not build it yet.

## Proposed Model

### Command approval

Keep dynamic approvals for execution-policy cases:

- once
- task
- session or workspace

This remains the home of `allowAlways`.

### Structural permissions

Treat missing structural sandbox permissions as:

- a broker/configuration problem
- surfaced via `PRIVILEGE_ELEVATION_REQUIRED`
- not dynamically granted in the current runtime

The recovery path should point to:

- agent config change
- broker policy change
- future admin-grade elevation flow only if explicitly introduced later

## Consequences

### What we should keep

- the semantic distinction between command approval and missing structural
  privilege
- `PRIVILEGE_ELEVATION_REQUIRED` as an agent-facing error code
- backend-level raw permission errors such as `SANDBOX_PERMISSION_DENIED`

### What we should avoid for now

- temporary runtime privilege grants
- `always allow` for structural permissions
- a second approval store for privilege elevation
- conversational elevation UX that looks equivalent to command approval

## Near-Term Cleanup

1. Reword recovery text for `PRIVILEGE_ELEVATION_REQUIRED` so it does not imply
   that temporary elevation already exists.
2. Keep `privilegeElevation.supported = false` in runtime capabilities until a
   real feature exists.
3. Continue to normalize backend permission denials into an agent-facing runtime
   error without adding a second enforcement system.

## Trigger To Reopen This

Revisit this decision only if we hit a real product need such as:

- operator-approved temporary widening of sandbox permissions
- admin-mediated short-lived elevation for a task
- strong need for runtime policy experiments without config changes

Until then, the simpler model is preferable:

- one dynamic approval system for commands
- one static broker/config system for structural permissions
