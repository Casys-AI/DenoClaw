# Broker Sandbox Isolation Plan

## Status

Planned as the next minimal-risk sandbox refactor.

## Goal

Make broker-backed sandboxes honest and safe enough for multi-agent use without
widening scope into snapshots, volumes, or agent-driven provisioning.

## Why this plan exists

The current cloud sandbox wiring is sufficient for bring-up and smoke tests, but
it is not a sound long-term isolation model for multiple agents.

Today, the broker can reuse a cloud sandbox too broadly. That creates a gap
between:

- the ownership semantics we want
- the labels we would like to attach
- the actual isolation guarantees of the runtime

## Design rule

For now, the agent should not provision or reason about sandboxes.

The contract stays simple:

- agent asks for a tool
- broker decides how and where it runs

## Scope of this plan

This plan is intentionally narrow.

Included:

- isolation between agents
- explicit sandbox ownership
- clear VM labels
- basic lifecycle management
- minimal telemetry for sandbox reuse vs cold start

Not included:

- snapshots
- persistent volumes
- sandbox profile catalog exposed to agents
- per-task sandboxing
- advanced scheduling / regional placement

## Invariants

The refactor should enforce these invariants:

1. No cross-agent sandbox reuse.
2. Sandbox ownership must be explicit and truthful.
3. VM labels must describe the sandbox itself, not execution-scoped metadata.
4. Execution-scoped metadata must stay in logs / telemetry.
5. The broker owns provisioning and reuse decisions.
6. The agent remains unaware of sandbox lifecycle internals.

## Minimal target model

The minimum acceptable model is:

- one sandbox pool managed by the broker
- reuse allowed only within the same `agentId`
- no reuse across different agents
- network policy changes cause sandbox recycle instead of in-place mutation

This gives us a clean baseline without forcing a heavier per-task model yet.

## Concrete plan

### 1. Add execution identity to the tool execution contract

Extend the broker -> tool execution request so it carries explicit execution
context, at least:

- `agentId`
- `taskId?`
- `contextId?`
- `ownershipScope`

The immediate goal is to stop treating sandbox execution as anonymous.

### 2. Introduce a broker-side SandboxManager

Add a dedicated manager responsible for:

- acquire sandbox
- reuse sandbox
- release sandbox
- evict idle sandbox
- close all sandboxes on shutdown

This moves lifecycle decisions out of the raw backend class.

### 3. Key sandbox reuse by agent identity

The initial reuse key should be based on:

- `agentId`
- network policy fingerprint
- sandbox backend kind

At minimum, `agentId` must be part of the key.

### 4. Keep the cloud backend focused on one owned sandbox

The cloud backend should represent one concrete sandbox instance and stop being
treated as a broker-wide singleton.

The manager decides which backend instance to use.

### 5. Add standard VM labels

For each sandbox, attach labels that describe the VM honestly, for example:

- `app=denoclaw`
- `env=prod`
- `owner_scope=agent`
- `owner_id=<agentId>`
- `backend=cloud`

These labels should stay stable for the life of the sandbox.

### 6. Keep execution metadata out of labels

Do not put these on sandbox labels:

- `taskId`
- `contextId`
- `tool`
- approval decisions

Those belong in structured logs, traces, and broker telemetry.

### 7. Add basic lifecycle rules

Start with simple rules:

- idle timeout
- eviction on shutdown
- recycle when the sandbox envelope no longer matches the requested policy

The first important mismatch is network policy.

### 8. Add focused tests

Cover the baseline behavior:

- same agent can reuse its sandbox
- `alice` does not reuse `bob`'s sandbox
- network policy mismatch creates a fresh sandbox
- labels match sandbox ownership
- idle sandboxes are evicted

## Success criteria

This plan is successful when:

- broker-backed tool execution still works
- sandboxes are no longer shared across agents
- sandbox labels are truthful
- logs can explain which agent used which sandbox
- no snapshot/volume work was required to get there

## Deferred on purpose

These are explicitly phase 2:

- snapshot-based base images
- persistent per-agent volumes
- higher-level sandbox capability profiles
- per-task or per-session isolation modes
- exposing any sandbox catalog to agents

## Recommended sequencing

Implement in this order:

1. execution context in `ToolExecutionPort`
2. `SandboxManager`
3. per-agent reuse key
4. truthful labels
5. lifecycle + eviction
6. tests

## Guiding principle

Do not optimize before the ownership model is correct.

The first priority is not startup speed or persistence. The first priority is to
make sandbox reuse explicit, bounded, and safe.
