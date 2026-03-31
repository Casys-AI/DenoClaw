# ADR-016: Broker Sandbox Ownership and Lifecycle

**Status:** Accepted **Date:** 2026-03-31 **Related:** ADR-001, ADR-005,
ADR-010

## Context

ADR-010 introduced the dual sandbox backend model:

- local subprocess backend for dev/offline execution
- Deno Sandbox backend for cloud execution

That ADR intentionally focused on execution policy and backend shape, but it
did not fully settle the **ownership** and **lifecycle** model of broker-backed
cloud sandboxes.

With real broker-backed sandbox execution now working, several missing
decisions became explicit:

1. A broker-wide shared sandbox weakens isolation between agents.
2. Labels such as `agent=bob` are only truthful if ownership is actually
   agent-scoped.
3. The broker plan on the free tier has a hard practical capacity constraint.
4. Snapshots and volumes are promising, but they are not required to fix the
   current ownership problem.

The architecture therefore needs a broker-side sandbox lifecycle model, not
just a raw cloud backend.

## Decision

### 1. The broker owns sandbox provisioning

Agents do not provision, name, mount, or recycle sandboxes directly.

The agent contract remains:

- request a tool
- receive a result

The broker decides:

- whether execution is allowed
- whether a sandbox is required
- which sandbox instance is reused or created
- when a sandbox is recycled or destroyed

### 2. Sandbox ownership is agent-scoped in v1

The minimum safe ownership scope is:

- one broker-managed sandbox owner per `agentId`

Therefore:

- cross-agent sandbox reuse is forbidden
- sandbox labels may truthfully identify the owning agent

This is the baseline isolation model for production multi-agent execution.

### 3. A broker-wide shared sandbox is not an acceptable target model

A single cloud sandbox reused across different agents is acceptable only as an
early bring-up implementation, not as the target runtime design.

Reasons:

- filesystem/process state isolation becomes weak or false
- network policy isolation becomes weak or false
- ownership labels become misleading
- lifecycle behavior becomes harder to reason about

### 4. VM identity and execution identity are separate concerns

Sandbox-level labels must describe the VM itself.

Execution-scoped metadata must remain outside the VM labels.

#### Sandbox-level identity

Examples:

- `app=denoclaw`
- `runtime=broker`
- `backend=cloud`
- `owner_scope=agent`
- `owner_id=<agentId>`

#### Execution-level identity

Examples:

- `taskId`
- `contextId`
- `tool`
- approval / policy decisions

These belong in broker logs, traces, and telemetry.

### 5. Broker capacity is explicit and bounded

The broker must enforce a configurable upper bound on the number of active
cloud sandboxes.

The environment variable is:

- `MAX_SANDBOXES_PER_BROKER`

Default:

- `5`

This matches the current practical quota constraint of the free plan.

If the broker reaches this limit, it must fail explicitly rather than create
additional sandboxes implicitly.

### 6. Same-agent concurrency is deferred as a separate design problem

This ADR does **not** adopt a model where a single agent may freely multiplex
multiple concurrent writable execution contexts inside the same sandbox.

For now, the architectural unit is:

- `agentId` -> sandbox owner

If same-agent concurrency is introduced later, it must be modeled explicitly
through a second ownership dimension such as:

- `workspaceId`
- `sessionId`
- `taskId`

In other words, future same-agent concurrency should look like:

- one agent
- multiple isolated workspaces / execution contexts
- one sandbox per workspace/session/task as needed

It should **not** be modeled as anonymous parallelism inside one shared
agent-scoped writable sandbox.

### 7. Snapshots and volumes are phase 2, not prerequisites

Snapshots and volumes are valuable future tools for:

- faster bootstrap
- persistent caches
- durable agent state
- browser / CLI / MCP runtime packaging

However, they do not solve the primary ownership problem by themselves.

Therefore:

- snapshots are deferred
- persistent volumes are deferred
- no agent-facing catalog is introduced in v1

The first priority is a correct isolation and lifecycle model.

## Consequences

### Immediate consequences

- broker-side sandbox management becomes a first-class runtime concern
- the lifecycle cannot remain embedded only inside the raw backend class
- sandbox ownership must be explicit in the execution contract
- labels become meaningful and auditable

### Required implementation direction

The broker runtime should have:

- a `SandboxManager`
- sandbox reuse keyed by at least `agentId`
- no cross-agent reuse
- explicit idle eviction / recycle rules
- explicit capacity rejection when the broker is full

### Required lifecycle hardening

This ADR also implies that lifecycle safety matters as much as the ownership
key itself.

The model must ultimately account for:

- active executions
- safe recycle semantics
- safe eviction semantics
- synchronization on acquisition

Without those, a conceptually correct ownership model can still be operationally
unsafe.

## Non-Goals

This ADR does not define:

- snapshot build pipelines
- volume layout or retention policy
- region placement strategy
- same-agent multi-workspace execution model
- cost optimization strategy beyond the broker capacity limit

## Rationale

This decision keeps the first production-safe sandbox model simple:

- broker orchestrates
- agent remains unaware of infrastructure details
- ownership is truthful
- labels are trustworthy
- capacity is bounded

It avoids prematurely coupling the system to advanced storage/runtime features
before the isolation model itself is correct.
