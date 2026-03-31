# ADR-011: A2A as the Canonical Internal and External Contract

**Status:** Accepted **Date:** 2026-03-28

## Context

The repository already has the right architectural intuition:

- **A2A** describes agent work
- the **worker protocol** coordinates local runtime behavior
- **KV** persists state and traces

The remaining problem is subtler: several broker↔agent and worker↔broker paths
still carry custom envelopes that behave like a second task model. That creates
two competing narratives for the same system:

1. an A2A narrative for network transport and documentation
2. a custom broker/worker narrative for local execution

That ambiguity makes lifecycle invariants, human pauses, traceability, and
transport migration harder than they need to be.

## Decision

**A2A becomes the single canonical contract for representing agent work, both
internally and externally.**

Concretely:

- **task intent** belongs to A2A
- **task lifecycle** belongs to A2A
- **artifacts** belong to A2A
- **continuation** and **cancellation** belong to A2A
- **human-input pauses** belong to the A2A lifecycle

The **worker protocol** stays, but is reduced strictly to infrastructure and
runtime concerns:

- `init`
- `ready`
- `shutdown`
- transport of approval / resume requests
- low-level execution coordination
- any observability hooks that are still required

It is no longer allowed to act as a second task contract.

## Normative rules

### 1. One task model only

Every unit of agent work must be representable as an A2A task, whether it runs:

- locally through `postMessage`
- remotely over HTTP
- in streaming form over SSE

The transport may vary. Task semantics may not.

### 2. Same lifecycle locally and over the network

Canonical transitions live in the A2A model, not in a local-only wrapper.

The sentence that should remain true everywhere is:

> **A2A over transport X, persisted in KV, correlated by task/context ids.**

Examples:

- **Local:** A2A over `postMessage`, persisted in KV, correlated by
  task/context ids.
- **Deploy:** A2A over HTTP + SSE, persisted in KV, correlated by task/context
  ids.

### 3. Human pauses are visible in canonical state

Approvals, confirmations, and clarifications may travel through the worker
protocol, but their effect must always be reflected in A2A state:

- `INPUT_REQUIRED` when the task is waiting for human input
- `WORKING` when it resumes
- `REJECTED` when the outcome is a human or policy denial rather than an
  execution failure

The specific awaited-input type must be represented in structured,
machine-readable metadata.

### 4. KV is durable storage, not magical transport

Deno KV remains the durable layer for:

- task state
- history
- artifacts
- traces
- correlation
- idempotence
- checkpoints and leases when needed

**KV Queue is not the canonical broker↔agent model.** If it exists at all, it
is only a local or broker-internal implementation detail.

### 5. The mental model is no longer RPC-centric

The system should be thought of in task operations:

- submit task
- stream or poll task
- continue task
- cancel task
- finish in a terminal state

A synchronous fast path is still an optimization, not the core contract.

## Responsibility comparison

| Topic                        | Canonical                                  | Notes                                                                      |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| canonical task contract      | **A2A Task / Message / Artifact lifecycle** | Single source of truth for agent work                                      |
| runtime/infra protocol       | **internal worker protocol**               | `init`, `ready`, `shutdown`, approval transport, low-level wiring          |
| storage layer                | **Deno KV**                                | Persistence, traces, idempotence, history                                  |
| local transport              | **`postMessage` / worker bridge**          | A2A over local transport, persisted in KV, correlated by task/context ids  |
| network transport            | **HTTP + SSE**                             | A2A over network transport, persisted in KV, correlated by task/context ids |
| observability correlation ids | **`taskId` + `contextId`**                | Correlate broker, worker, agent, artifacts, and traces                     |

## Implementation notes

### Atomic TOCTOU-safe privilege-elevation grants

Privilege-elevation grants are stored in broker-owned metadata, with task-scoped
grants on the task record and session-scoped grants on the shared context
record. One-shot grants are consumed atomically through `kv.atomic().check().set()`,
so only one execution can use a given grant. That prevents races between two
simultaneous resumptions for the same task or context.

## Consequences

### Positive

- one coherent story for the runtime
- lifecycle invariants become centralized
- human pauses are visible in real task state
- better portability between local and deploy modes
- transport migration no longer duplicates the task model

### Negative / cost

- compatibility bridges have to remain temporarily
- some internal types/messages must be reclassified as infra-only
- existing docs need to be tightened so they stop implying a parallel contract

## What this ADR does not imply

This ADR:

- **does not remove** local Workers or subprocesses
- **does not remove** the worker protocol
- **does not require** raw JSON-RPC objects at every internal callsite
- **does not remove** KV from persistence

It only enforces a strict boundary:

- **A2A = task contract**
- **worker protocol = runtime plumbing**
- **KV = durable storage**

## Migration status

Until the compatibility bridges are completely removed, any internal message
that looks like a task should be evaluated with one question:

> Is this agent-work semantics? If yes, it belongs to A2A.

If the answer is no, it may stay in the worker protocol as a runtime detail.
