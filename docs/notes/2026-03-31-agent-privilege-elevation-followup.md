# 2026-03-31 — Agent privilege elevation follow-up

## Context

We need to distinguish between:

- command approval inside an already-authorized sandbox envelope
- structural privilege elevation that changes the sandbox envelope itself

Examples:

- `git status` not in allowlist -> command approval problem
- agent missing `net` or `write` -> privilege elevation problem

These two concerns should not share the same runtime approval model.

## Decision Direction

Keep broker-side authority for all effective permissions.

Allow Claude-like approvals for command execution, but keep structural sandbox
permissions stricter and separately governed.

## Approved Direction

### 1. Command approvals can be interactive and scoped

For shell and similar execution-policy cases, support approval scopes such as:

- once
- task
- session or workspace
- persistent config update later if explicitly promoted

This applies to commands inside an already-authorized sandbox envelope.

### 2. Structural sandbox privileges must not use simple "always allow"

Do not treat these like normal command approvals:

- `read`
- `write`
- `run`
- `net`
- `env`
- `ffi`

Granting one of these changes the security envelope of the agent runtime.

Runtime approval for these privileges should be:

- deny by default
- optionally temporary
- broker-scoped
- auditable

### 3. Durable privilege changes are administrative, not conversational

If an agent should permanently gain a structural permission, this should become
a broker or agent configuration change, not an implicit runtime approval.

### 4. Stronger elevation flow later

For future privilege elevation, prefer a stronger mechanism than normal command
approval, for example:

- explicit elevation request
- bounded scope
- short TTL
- audit trail
- optional second-factor or admin-grade confirmation

## Consequences

- agents should know their high-level runtime capabilities
- brokers remain the source of truth for effective permissions
- command approval UX can be relatively lightweight
- privilege elevation UX must be deliberately heavier

## Out of Scope

- exact UX for elevation prompts
- admin UI
- durable privilege management workflow
- implementation details for 2FA or signed approvals

## Follow-up

If this direction remains stable, promote it into a dedicated ADR for:

- command approval scopes
- structural privilege elevation semantics
- audit and TTL model
- broker-side policy authority

## Near-Term Steps

Without taking much risk, the next implementation slice should be:

1. Introduce an `AgentRuntimeCapabilities` projection injected into the agent.
2. Distinguish command approval from privilege elevation in broker errors.
3. Standardize approval scopes around:
   - once
   - task
   - session or workspace
4. Keep structural sandbox permissions static for now, even if command approvals
   become more ergonomic.
