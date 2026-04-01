# Context Lifecycle Plan

**Date:** 2026-03-31 **Status:** Proposed

## Goal

Introduce an explicit broker-governed lifecycle for agent work contexts, so an
agent can start, fork, and close contexts without turning raw session/runtime
plumbing into a model-facing concern.

Target model:

- agent-facing tools manipulate work contexts, not low-level runtime sessions
- the broker remains the authority for creation, closure, ownership, and
  resource attachment
- context lifecycle is explicit, while privilege grants and sandbox ownership
  remain scoped to `contextId`
- later, sandbox snapshots and volumes can attach to context open/fork flows,
  but they are not part of v1

## Findings

- `contextId` is already the strongest current unit for same-agent concurrency
  and sandbox ownership
- `session`-scoped privilege grants are already keyed by `agentId + contextId`,
  so context is the right future lifecycle boundary
- the current system still relies mostly on TTL-based expiry for session-like
  state, which is good enough for safety but weak for operability
- if agents need to parallelize work cleanly, the useful primitive is not “start
  a raw session”, but “open a new work context”
- future snapshot/volume attachment fits naturally at context open/fork time,
  not at arbitrary tool-execution time

## Design principles

1. The broker owns lifecycle decisions.
2. Agents request context operations; they do not mutate runtime ownership
   directly.
3. Context lifecycle must stay explicit and auditable.
4. Closing a context must revoke context-scoped privilege grants immediately.
5. Context operations must preserve isolation across concurrent same-agent work.
6. v1 should not require snapshots or volumes.

## Proposed v1 API

Expose agent-facing tools or runtime operations with semantics like:

- `open_context` start a fresh work context for the current agent
- `fork_context` start a new work context derived from the current one
- `close_context` explicitly close the current or a child-owned context
- optional later: `list_contexts`

The important point is that these are conceptual context operations. They are
not raw “session start/stop” syscalls exposed directly to the model.

## Broker responsibilities

When handling context lifecycle, the broker should:

1. Create or derive a new `contextId`.
2. Decide sandbox ownership and reuse policy for that context.
3. Carry over or reset state according to the operation:
   - `open_context`: fresh context, no inherited grants
   - `fork_context`: inherited lineage/metadata, but isolated grants unless
     explicitly regranted
   - `close_context`: revoke active context grants and mark related runtime
     state evictable
4. Emit auditable lifecycle events for open/fork/close.

## Close semantics

`close_context` should:

- revoke all active `session`/context-scoped privilege grants for that
  `agentId + contextId`
- prevent new resumptions on that context
- mark the sandbox for that context as evictable or close it immediately if not
  in use
- keep immutable history/task records intact for audit

Closing a context should clean up active privilege state and runtime ownership;
it should not destroy historical task records.

## Fork semantics

`fork_context` should create a new child context that:

- gets a new `contextId`
- may inherit high-level lineage metadata from the parent
- does not automatically inherit temporary privilege grants
- gets its own sandbox ownership scope

This keeps concurrency safe while still making “continue this idea in a new
workspace/context” a first-class capability.

## Non-goals for v1

This plan does not include:

- snapshot attachment
- persistent volume attachment
- arbitrary cross-agent context takeover
- direct low-level sandbox manipulation by agents

## Future extension: snapshots and volumes

Later, context lifecycle can become the natural place to attach storage/runtime
profiles:

- `open_context(profile=browser)` could choose a snapshot
- `fork_context(from=current)` could derive a new context with a copied or fresh
  writable volume
- context creation could select from broker-managed sandbox/storage profiles

That extension is intentionally deferred. The v1 goal is to make context
lifecycle explicit first, then attach richer runtime/storage provisioning later.

## Implementation order

1. Add a broker-side context lifecycle service with `open`, `fork`, and `close`.
2. Define the agent-facing operation contract (`open_context`, `fork_context`,
   `close_context`).
3. Make `close_context` revoke context-scoped privilege grants immediately.
4. Tie sandbox ownership cleanup to closed contexts.
5. Add tests for:
   - same-agent parallel contexts
   - close revokes grants
   - fork does not leak temporary grants
6. Revisit snapshot/volume attachment only after the lifecycle semantics are
   stable.
