# 2026-03-31 — Exec approval deprecation direction

## Context

The current design still carries an interactive execution-approval model:

- `ask: "on-miss" | "always"`
- `EXEC_APPROVAL_REQUIRED`
- `allowAlways`
- session-scoped command approval memory

This model came from a copilot-style workflow where a human is expected to click
through command execution.

That does not fit the target runtime model for Denoclaw:

- agents are autonomous
- broker and sandbox policy are the real security boundary
- remote agents should not depend on per-command human confirmation
- local and remote should converge on the same trust model

## Reassessment

We should not treat exec approval as a core security primitive.

If the runtime is designed correctly, security should come from:

- sandbox permissions
- static broker-side policy
- static `execPolicy`
- sandbox isolation and lifecycle
- bounded network access

Not from an operator clicking "yes" on each shell command.

## Decision Direction

Move exec approval out of the main design path.

Keep structural privilege handling as the useful interactive exception.

In practice:

- `EXEC_APPROVAL_REQUIRED` should be deprecated as a primary runtime state
- `allowAlways` should not remain a central product concept
- `PRIVILEGE_ELEVATION_REQUIRED` remains useful
- future human/operator intervention should happen at the privilege-elevation
  layer, not at the command-approval layer

## Target Model

### 1. Command execution is governed by static policy

Commands should be allowed or denied by:

- sandbox permissions such as `run`
- `execPolicy.security`
- `shell.mode`
- command allowlists or deny rules where applicable

If a command is not permitted by this policy, the runtime should return a
structured denial such as:

- `EXEC_POLICY_DENIED`

This should not trigger an interactive approval flow in the normal autonomous
path.

### 2. Structural privilege change remains meaningful

If the current sandbox envelope is insufficient, the runtime should surface:

- `PRIVILEGE_ELEVATION_REQUIRED`

This is still useful because it means something materially different:

- the command itself may be valid
- but the agent lacks the privilege envelope required to perform it

Examples:

- missing `net`
- missing `write`
- missing `env`
- missing `ffi`

## Why This Is Cleaner

### 1. Better fit for autonomous agents

Autonomous agents should not block on a human click for ordinary command
execution.

### 2. One real security model

Security remains centered on:

- broker policy
- sandbox envelope
- static exec policy

Instead of being split between:

- static policy
- interactive command approvals

### 3. Simpler runtime semantics

The runtime surface becomes easier to explain:

- command denied by policy
- privilege missing from sandbox envelope

Instead of:

- command denied
- command approval required
- privilege elevation required
- remembered approvals

### 4. Better local/remote convergence

The deployed broker cannot rely on a local copilot-style prompt loop.

If the remote model is non-interactive, the local model should not drift too far
away from it.

## Future Human Intervention

Human intervention may still be useful, but at the right layer.

The likely future model is:

- broker emits `PRIVILEGE_ELEVATION_REQUIRED`
- an operator-facing approval UI receives the request
- broker records a bounded elevation decision
- execution resumes under the updated broker-side grant

This approval UI does not need to be built into the agent runtime itself.

It could be attached to an operator channel such as:

- Telegram inline buttons
- admin web UI
- dashboard action
- signed API callback

The important design point is:

- the channel is only an approval surface
- the broker remains the source of truth
- the agent does not self-grant privileges

## Consequences

### Near-term implications

- stop treating `ask` as a primary runtime feature
- stop expanding `allowAlways` / session command grants as a strategic path
- keep `PRIVILEGE_ELEVATION_REQUIRED` as the meaningful interactive hook
- keep backend permission errors normalized into agent-facing runtime errors

### Longer-term implications

If we later add operator approvals, they should apply to:

- bounded privilege elevation
- explicit scope
- TTL
- audit trail

Not to routine command execution.

## Migration Direction

1. Reword docs and recovery text so exec approval is no longer presented as the
   main path.
2. Keep current `ask` compatibility only as legacy or development behavior.
3. Introduce a clean product distinction between:
   - policy denial
   - privilege elevation required
4. Design any future operator approval flow around privilege elevation only.

## Relationship To Other Notes

This note sharpens and partially supersedes the earlier direction in:

- [2026-03-31-privilege-elevation-redundancy-review.md](./2026-03-31-privilege-elevation-redundancy-review.md)

The earlier note argued against a second approval track for structural
privileges.

This note goes further:

- command approvals themselves should no longer be treated as a core design
  pillar for autonomous agents
