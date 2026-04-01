# 2026-03-31 — Privilege elevation redundancy review

## Context

We introduced an agent-facing distinction between:

- legacy command-approval-required states
- `PRIVILEGE_ELEVATION_REQUIRED`

This is useful semantically because these two failures do not mean the same
thing:

- legacy command approval: the action fits inside the current sandbox envelope,
  but waits for a per-command approval
- privilege elevation: the current sandbox envelope itself is insufficient

At the same time, the current runtime model is already strongly broker-governed:

- broker-side sandbox policy is the source of truth
- structural permissions are configured statically
- agents do not provision their own sandbox envelope
- backend permission checks are already enforced before execution

That originally made a second runtime approval track for structural privilege
elevation look redundant.

## Reassessment

The semantic distinction is useful.

The older double-workflow was not.

The current runtime should keep the agent-facing error taxonomy while letting
privilege elevation, not command approval, carry the only resumable workflow.

## Decision Direction

For the current runtime:

- keep `PRIVILEGE_ELEVATION_REQUIRED` as the structural, resumable runtime hook
- keep privilege grants broker-controlled
- do not reintroduce a second command-approval track

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

### 2. Less conceptual overlap

If runtime command approval and structural privilege elevation both exist as
first-class workflows, the model becomes harder to explain and harder for agents
to reason about.

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

### Execution policy

Keep execution policy static and broker-governed:

- commands either pass policy or return `EXEC_POLICY_DENIED`
- command approval is not a first-class runtime flow anymore

### Structural permissions

Treat missing structural sandbox permissions as:

- a broker-owned privilege-elevation concern
- surfaced via `PRIVILEGE_ELEVATION_REQUIRED`
- granted only through bounded broker-side privilege grants when enabled

The recovery path should point to:

- broker-side privilege grant
- agent config change when elevation is disabled
- broker policy change when the agent should have the capability by default

## Consequences

### What we should keep

- the semantic distinction between command approval and missing structural
  privilege
- `PRIVILEGE_ELEVATION_REQUIRED` as an agent-facing error code
- backend-level raw permission errors such as `SANDBOX_PERMISSION_DENIED`
- broker-owned, bounded privilege grants as the only resumable path

### What we should avoid

- unbounded structural privilege escalation
- remembered command approvals as a parallel control path
- conversational UX that turns privilege elevation back into command approval

## Near-Term Cleanup

1. Reword recovery text for `PRIVILEGE_ELEVATION_REQUIRED` so it does not imply
   the wrong operator surface.
2. Keep runtime capabilities aligned with actual broker-owned privilege
   elevation support.
3. Continue to normalize backend permission denials into an agent-facing runtime
   error without adding a second enforcement system.

## Trigger To Reopen This

Revisit this decision only if we hit a real product need such as:

- operator-approved temporary widening of sandbox permissions
- admin-mediated short-lived elevation for a task
- strong need for runtime policy experiments without config changes

Until then, the simpler model is preferable:

- one policy-first execution model
- one broker-owned privilege-elevation system for bounded structural widening
