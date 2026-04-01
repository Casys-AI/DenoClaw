# Broker Sandbox Naming Follow-up

## Status

Deferred on purpose after the first successful broker-backed sandbox path, but
now identified as a real architecture follow-up, not a cosmetic cleanup.

## What is already true

The broker-backed cloud sandbox now exists as a real runtime concern:

- broker owns sandbox provisioning
- the sandbox backend is created in broker bootstrap/runtime code
- the current backend lazily creates a VM and then reuses it

Today, this means the sandbox identity is broker-scoped, not agent-scoped.

## Current constraint

We should not attach agent-specific meaning to the sandbox identity yet.

With the current lifecycle, a single sandbox can serve multiple tool calls over
time, potentially from different agents and different tasks. So labels like:

- `agent=bob`
- `task=...`
- `createdBy=alice`

would be misleading if attached to the sandbox object itself.

This is not only a naming issue. It is also an ownership and isolation issue.

If the same sandbox can be reused across agents, then sandbox-level state and
network policy are not truly agent-scoped.

## Current risk

The current shared-broker sandbox shape should be treated as a bring-up
implementation, not as the target multi-agent isolation model.

If a sandbox is reused across agents, the following guarantees become weak or
false:

- filesystem/process state isolation between agents
- network policy isolation between agents
- truthful attribution of sandbox ownership
- meaningful agent/task labels on the sandbox object itself

This means the lifecycle model is part of the security model.

## What Deno Sandbox already provides

`@deno/sandbox` already exposes a standard tagging mechanism on
`Sandbox.create()` via `labels`.

That should be the canonical place for sandbox identity metadata at the VM
level, instead of inventing a separate ad hoc naming field.

## Rule for now

If we add sandbox naming/tagging now, it should be limited to static VM labels,
for example:

- `app=denoclaw`
- `role=broker-tools`
- `env=prod`
- `backend=cloud`

These describe what the sandbox is, without pretending it belongs to a single
agent or task.

## What should stay dynamic

Execution-scoped metadata should stay outside sandbox labels:

- `agentId`
- `taskId`
- `contextId`
- `tool`
- approval / policy decisions

Those belong in broker logs, telemetry, traces, and correlation fields on tool
execution, not in the sandbox VM identity.

## Required follow-up

Later, we should design sandbox identity and lifecycle together instead of
treating naming as a cosmetic concern.

The follow-up should decide:

1. Sandbox lifecycle model:
   - single shared broker sandbox
   - sandbox pool
   - one sandbox per agent
   - one sandbox per task/session
2. Sandbox ownership model:
   - who "owns" the sandbox
   - whether ownership is broker-scoped, agent-scoped, or task-scoped
   - whether a sandbox may ever be reused across different agents
3. Standard label schema for sandbox-level identity.
4. Standard execution metadata schema for per-call observability.
5. Cleanup and reuse rules:
   - idle timeout
   - explicit eviction
   - warm pool vs cold create
6. Whether we want a synthesized human-readable display name derived from
   labels, instead of a separate mutable "name" field.

## Important consequence

If we want labels such as "which agent created this sandbox", we first need a
lifecycle where that statement is actually true.

In other words:

- agent/task attribution requires agent/task-scoped sandbox ownership
- sandbox-level labels must not imply ownership that the runtime does not honor
- cross-agent sandbox reuse weakens isolation guarantees and should be treated
  as a conscious architecture choice, not an incidental implementation detail
- if we want real isolation between agents, the baseline should move to at least
  one sandbox per agent, and possibly one sandbox per task/session

## Rule for later

When revisiting this, prefer:

- standard `labels` for VM identity
- explicit broker telemetry for execution identity
- lifecycle-driven ownership semantics
- explicit isolation rules between agents

Do not add agent/task labels to a reused shared sandbox before the lifecycle
model changes.

Do not treat the current shared sandbox lifecycle as the final isolation model
for production multi-agent execution.
