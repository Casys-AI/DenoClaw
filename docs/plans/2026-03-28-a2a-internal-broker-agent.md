# A2A-First Broker↔Agent Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Make A2A the canonical internal task contract for broker↔agent and
agent↔agent execution, while reducing the worker protocol to strict
runtime/infra concerns only.

**Architecture:** DenoClaw keeps one canonical story. A2A owns task intent,
lifecycle, artifacts, continuation, cancellation, and human-input pauses. The
internal worker protocol remains, but only for runtime plumbing such as `init`,
`ready`, `shutdown`, approval transport, and low-level execution coordination.
KV remains durable state and trace storage, not the canonical transport.

**Tech Stack:** Deno 2.x, Deno KV, Web Workers / subprocess workers, HTTP + SSE,
existing `src/messaging/a2a/*`, existing broker/worker runtime.

---

## Version baseline

Plan written against repository state:

- Branch: `main`
- Initial HEAD: `5fdb41a` — `Wire Fresh dashboard into gateway runtime`

## Progress snapshot (updated during execution)

### Completed

- **Phase 0 / Task 0.1** — docs + ADR boundary clarified
- **Phase 1 / Task 1.1** — canonical internal A2A invariants
- **Phase 1 / Task 1.2** — structured awaited-input metadata
- **Phase 1 / Task 1.3** — transport-agnostic runtime port
- **Phase 2 / Task 2.1** — `taskId` / `contextId` propagation through
  runtime/tracing
- **Phase 3 / Task 3.1** — deterministic local worker → canonical A2A mapping
- **Phase 3 / Task 3.2** — local worker execution routed through canonical A2A
  path
- **Phase 4 / Task 4.1** — worker protocol reduced to strict runtime plumbing,
  with bridge messages explicitly treated as compatibility-only
- **AX tightening batch** — `src/messaging/a2a/contract.md`, public
  `A2ARuntimePort` surface, duplicate `INPUT_REQUIRED` helper collapsed,
  canonical lifecycle helpers reused by runtime/store
- **Broker/client canonicalization (partial Phase 5 / 6 intent)**
  - broker now supports canonical task operations (`task_submit`, `task_get`,
    `task_continue`, `task_cancel`, `task_result`)
  - broker client now exposes task-oriented operations
  - canonical task results are persisted back into broker task storage from
    runtime execution
  - broker → agent initiation now routes canonical `task_submit` /
    `task_continue` instead of only legacy `agent_message`
  - broker-backed shell approvals now produce canonical `INPUT_REQUIRED` instead
    of silently bypassing lifecycle truth

- **Privilege-elevation semantics hardened**
  - decision: keep one-shot/task/session grant scopes
  - grants remain broker-owned and machine-readable
  - task/context persistence carries the effective temporary grants
- **Phase 6 — BrokerClient transport extraction**
  - `BrokerTransport` interface + `KvQueueTransport` extracted
  - `BrokerClient` refactored to accept pluggable transport via DI
  - `pendingRequests` moved from client to transport implementation
- **Phase 7 — KV Queue demoted**
  - `AgentRuntime.start()` no longer starts KV Queue intake —
    `startKvQueueIntake()` for local, HTTP handler for deployed agent apps
  - `handleIncomingMessage()` is the canonical transport-agnostic entry point
  - `MessageBus` fallback removed — fails explicitly if not initialized
  - `MessageBus` tracks KV ownership (no double-close)
- **Legacy sendToAgent/agent_message removed**
  - `sendToAgent` removed from `AgentBrokerPort` and `BrokerClient`
  - `handleLegacyAgentMessage` removed from `AgentRuntime`
  - `legacyReplyTarget` removed — all execution paths are canonical task flows
  - `executeConversation` now requires `canonicalTask` (no more nullable)

- **task_mapping.ts → task_mapping.ts**
  - renamed to `task_mapping.ts` (honest name)
  - removed boundary violation (`worker_protocol.ts` import)
  - `LocalTextInput` → standalone `TaskTextInput` (no agent/ dependency)
- **Broker legacy agent_message handler removed**
  - `handleAgentMessage`, `routeAgentMessage`, `sendAgentAck` removed
  - `routeBrokerMessageToAgent` type narrowed to `task_submit | task_continue`
    only

### Remaining work

- Worker protocol bridge messages (`agent_send`/`agent_deliver`/`agent_result`)
  still used for local inter-agent transport — these are plumbing, not task
  model

## What this plan is actually fixing

The repo already separates two concerns in principle:

- **A2A** for agent task semantics and inter-agent communication
- **worker protocol** for internal runtime coordination

That split is correct. The remaining problem is that execution still leaks
custom task-shaped envelopes in several local broker↔worker paths. That means
the naming is separated, but the runtime center of gravity is still split.

This plan does **not** remove the internal worker protocol. It makes the
boundary strict:

- **A2A = canonical task model**
- **worker protocol = infra/runtime plumbing only**
- **KV = durable persistence and tracing**
- **transport = postMessage locally, HTTP/SSE on the network**

## Non-goals

- Do not redesign all public APIs at once
- Do not remove local Workers / subprocess model
- Do not fully solve broker hosting/runtime placement in this plan
- Do not force raw JSON-RPC objects into every local callsite
- Do not remove all compatibility code in one shot before tests prove the new
  path

## Canonical decisions to preserve during implementation

### 1. A2A is the only canonical task contract

Anything that represents agent work must have one canonical shape and one
canonical lifecycle. Local execution and network execution may use different
transports, but must not use different task semantics.

### 2. The internal worker protocol stays, but becomes infra-only

The worker protocol continues to exist because the runtime still needs local
control messages. However, it must be constrained to things like:

- `init`
- `ready`
- `shutdown`
- approval transport
- execution wiring
- optional observability hooks

It must stop being a second task model.

### 3. Human pauses are visible in the canonical task lifecycle

Approvals, confirmations, and other human-input pauses are triggered through the
worker protocol, but their effect on the task must be visible in A2A state.

Use:

- `INPUT_REQUIRED` when the task is blocked on human input
- `WORKING` when resumed
- `REJECTED` when the human refusal is a policy/user denial rather than an
  execution failure

The specific awaited input type must be represented explicitly in structured
metadata.

### 4. KV is storage, not magical transport

Deno KV remains the durable store for:

- task state
- artifacts
- history
- tracing metadata
- idempotency keys
- leases/checkpoints if needed

KV Queue is not the canonical broker↔agent transport.

### 5. RPC is no longer the mental model

The system should think in terms of:

- submit task
- stream/poll status
- continue task
- cancel task
- finish in terminal state

Any synchronous fast path is an optimization of task semantics, not the
canonical model.

---

## Phase 0 — Lock the architecture in docs before touching runtime behavior

### Task 0.1: Write the missing ADR that makes the boundary explicit

**Files:**

- Create: `docs/adr-011-a2a-canonical-internal-protocol.md`
- Modify: `docs/adr-006-a2a-inter-agent-protocol.md`
- Modify: `docs/adr-008-agent-deploy-corrections.md`
- Modify: `docs/architecture-distributed.md`

**Step 1: Write the ADR** Document these decisions explicitly:

- A2A is the canonical internal and external task contract
- local and network execution share the same task lifecycle
- the worker protocol remains for infra/runtime only
- approvals are transported internally but exposed canonically as task state
- KV is durable storage, not the primary transport model
- KV Queue is optional implementation detail only

**Step 2: Add a comparison table** Include a table with these rows:

- canonical task contract
- runtime/infra protocol
- storage layer
- local transport
- network transport
- observability correlation ids

**Step 3: Update ADR-006 wording** Tighten any wording that still implies:

- A2A is only for “external” or “inter-agent over network” use
- custom broker envelopes remain a legitimate parallel task contract

**Step 4: Update architecture docs** Add one canonical sentence pattern
everywhere relevant:

- “A2A over transport X, persisted in KV, correlated by task/context ids.”

**Step 5: Run docs sanity check** Run:

```bash
cd /home/ubuntu/CascadeProjects/denoclaw
rg -n "KV Queue|BrokerMessage|process\(|agent_deliver|agent_send|agent_result|agent_response" docs src
```

Expected: a clear inventory of places that still describe or imply a parallel
task model.

**Step 6: Commit**

```bash
git add docs/adr-011-a2a-canonical-internal-protocol.md docs/adr-006-a2a-inter-agent-protocol.md docs/adr-008-agent-deploy-corrections.md docs/architecture-distributed.md
git commit -m "docs: define a2a as canonical internal task contract"
```

---

## Phase 1 — Freeze the internal A2A invariants before adding adapters

### Task 1.1: Define the internal canonical task invariants

**Files:**

- Create: `src/messaging/a2a/internal_contract.ts`
- Create: `src/messaging/a2a/internal_contract_test.ts`
- Reference: `src/messaging/a2a/types.ts`
- Reference: `src/messaging/a2a/tasks.ts`

**Step 1: Write the failing tests first** Cover the invariants that must never
drift:

- every task has stable `id`
- `contextId` policy is explicit
- valid state transitions only
- terminal states are protected
- `INPUT_REQUIRED -> WORKING` is allowed
- refusal path ends in `REJECTED` when applicable
- artifact emission does not mutate terminal tasks

Run:

```bash
cd /home/ubuntu/CascadeProjects/denoclaw
deno test src/messaging/a2a/internal_contract_test.ts
```

Expected: FAIL because file/module does not exist yet.

**Step 2: Implement the minimal invariant helpers** Add code that centralizes:

- allowed transitions
- terminal checks
- structured input-required metadata helpers
- rejection classification helpers

**Step 3: Run the focused tests** Run:

```bash
deno test src/messaging/a2a/internal_contract_test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/messaging/a2a/internal_contract.ts src/messaging/a2a/internal_contract_test.ts
git commit -m "feat: define canonical internal a2a task invariants"
```

### Task 1.2: Define explicit metadata for awaited human input

**Files:**

- Modify: `src/messaging/a2a/types.ts`
- Create: `src/messaging/a2a/input_metadata.ts`
- Create: `src/messaging/a2a/input_metadata_test.ts`

**Step 1: Write failing tests** Cover structured awaited-input metadata such as:

- approval request
- clarification request
- confirmation request
- resume payload shape

**Step 2: Add a typed metadata helper** Create a typed structure for the task
`INPUT_REQUIRED` reason, for example:

- `kind: "privilege-elevation" | "clarification" | "confirmation"`
- machine-readable fields for grants, scope, prompt, or continuation token

**Step 3: Ensure it composes with existing `TaskStatus.message` and `metadata`**
Do not explode the A2A schema. Keep the extra detail in structured
metadata/helpers.

**Step 4: Run tests**

```bash
deno test src/messaging/a2a/input_metadata_test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/messaging/a2a/types.ts src/messaging/a2a/input_metadata.ts src/messaging/a2a/input_metadata_test.ts
git commit -m "feat: add structured awaited-input metadata for a2a tasks"
```

### Task 1.3: Add transport-agnostic runtime port only after invariants exist

**Files:**

- Create: `src/messaging/a2a/runtime_port.ts`
- Create: `src/messaging/a2a/runtime_port_test.ts`
- Reference: `src/messaging/a2a/types.ts`
- Reference: `src/messaging/a2a/internal_contract.ts`

**Step 1: Write failing tests** Cover the interface expected by both local and
HTTP-backed adapters:

- submit task
- continue task
- get task
- stream task events
- cancel task

**Step 2: Add the interface** Keep it free of:

- `fetch`
- `postMessage`
- KV Queue assumptions
- worker-protocol details

**Step 3: Document why this comes after invariants** Leave a comment in the file
explaining that the port abstracts transports, not task semantics.

**Step 4: Run tests**

```bash
deno test src/messaging/a2a/runtime_port_test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/messaging/a2a/runtime_port.ts src/messaging/a2a/runtime_port_test.ts
git commit -m "feat: add transport-agnostic a2a runtime port"
```

---

## Phase 2 — Instrument correlation and tracing before migrating behavior

### Task 2.1: Propagate canonical task/context ids through runtime boundaries

**Files:**

- Modify: `src/telemetry/traces.ts`
- Modify: `src/agent/worker_entrypoint.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/orchestration/monitoring.ts`
- Test: `src/telemetry/traces_test.ts`

**Step 1: Write failing tests** Cover that:

- worker task execution carries task id
- context id persists across delegation/re-entry
- subprocess/worker activity can be correlated back to the parent task

**Step 2: Implement minimal propagation** Do not redesign tracing yet. Just
guarantee consistent IDs are emitted everywhere relevant.

**Step 3: Run focused tests**

```bash
deno test src/telemetry/traces_test.ts src/agent/loop_test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/telemetry/traces.ts src/agent/worker_entrypoint.ts src/agent/loop.ts src/orchestration/monitoring.ts src/telemetry/traces_test.ts
git commit -m "feat: propagate a2a task correlation ids through runtime"
```

---

## Phase 3 — Make the local worker path execute canonical A2A tasks

### Task 3.1: Add local A2A execution mapping helpers

**Files:**

- Create: `src/messaging/a2a/task_mapping.ts`
- Create: `src/messaging/a2a/internal_mapping_test.ts`
- Reference: `src/agent/worker_protocol.ts`
- Reference: `src/orchestration/types.ts`

**Step 1: Write failing tests** Cover deterministic mappings for:

- local text input -> canonical A2A task/message
- task result -> artifact + terminal status
- error -> failed/rejected status
- approval pause -> input-required status metadata

**Step 2: Implement the helpers** Make mappings explicit for:

- `sessionId` ↔ `contextId`
- request ids ↔ task ids
- final textual output ↔ artifacts
- human refusal ↔ `REJECTED`

**Step 3: Run tests**

```bash
deno test src/messaging/a2a/internal_mapping_test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/messaging/a2a/task_mapping.ts src/messaging/a2a/internal_mapping_test.ts
git commit -m "feat: add deterministic local-to-a2a mapping helpers"
```

### Task 3.2: Route worker execution through canonical A2A semantics

**Files:**

- Modify: `src/agent/worker_entrypoint.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/loop_test.ts`
- Create if needed: `src/agent/worker_entrypoint_test.ts`

**Step 1: Write failing tests** Cover local worker execution such that:

- submitted local work becomes a canonical A2A task
- state transitions are preserved
- output remains behaviorally unchanged for callers
- approval pause surfaces as `INPUT_REQUIRED`

**Step 2: Implement a canonical task execution path** Wrap the existing
`AgentLoop`; do not rewrite it from scratch.

**Step 3: Keep temporary compatibility only as a narrow bridge** If `process`
still exists during migration, it must delegate directly into the A2A execution
path and be marked for removal. Do not let it remain a first-class parallel API.

**Step 4: Run focused tests**

```bash
deno test src/agent/loop_test.ts src/agent/worker_entrypoint_test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/worker_entrypoint.ts src/agent/loop.ts src/agent/loop_test.ts src/agent/worker_entrypoint_test.ts
git commit -m "refactor: execute local worker requests via canonical a2a task path"
```

---

## Phase 4 — Shrink the worker protocol to infra-only semantics

### Task 4.1: Remove task-model leakage from `worker_protocol.ts`

**Files:**

- Modify: `src/agent/worker_protocol.ts`
- Modify: `src/agent/worker_pool.ts`
- Modify: `src/agent/worker_pool_test.ts`

**Step 1: Write failing tests** Cover that local worker orchestration still
works when task semantics are owned elsewhere.

**Step 2: Reclassify messages** Document each protocol message as one of:

- infra/runtime
- compatibility bridge slated for removal

Likely custom task-shaped messages to remove or de-emphasize:

- `process`
- `agent_deliver`
- `agent_send`
- `agent_result`
- `agent_response`

**Step 3: Keep infra-specific messages** Keep only things such as:

- `init`
- `ready`
- `shutdown`
- approval transport
- minimal execution coordination if still necessary

**Step 4: Run focused tests**

```bash
deno test src/agent/worker_pool_test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/worker_protocol.ts src/agent/worker_pool.ts src/agent/worker_pool_test.ts
git commit -m "refactor: reduce worker protocol to strict runtime plumbing"
```

---

## Phase 5 — Make broker flow canonical in task semantics

### Task 5.1: Rework broker APIs around task operations, not custom envelopes

**Files:**

- Modify: `src/orchestration/broker.ts`
- Modify: `src/orchestration/types.ts`
- Modify: `src/orchestration/broker_test.ts`
- Reference: `src/messaging/a2a/tasks.ts`
- Reference: `src/messaging/a2a/runtime_port.ts`

**Step 1: Write failing tests** Cover broker-level operations:

- submit task
- continue task
- get task
- stream task state
- cancel task
- preserve peer policy enforcement

**Step 2: Implement the canonical task-facing methods** `BrokerMessage` may
survive briefly as low-level routing metadata, but not as the primary
representation of agent work.

**Step 3: Ensure broker persistence matches the invariant helpers** States,
terminal transitions, and rejection handling must reuse the canonical transition
logic.

**Step 4: Run focused tests**

```bash
deno test src/orchestration/broker_test.ts src/messaging/a2a/tasks.ts
```

Expected: broker tests PASS.

**Step 5: Commit**

```bash
git add src/orchestration/broker.ts src/orchestration/types.ts src/orchestration/broker_test.ts
git commit -m "refactor: make broker route canonical a2a tasks"
```

### Task 5.2: Handle human-input continuation explicitly at broker level

**Files:**

- Modify: `src/orchestration/broker.ts`
- Modify: `src/orchestration/client.ts`
- Modify: `src/orchestration/client_test.ts`

**Step 1: Write failing tests** Cover:

- task enters `INPUT_REQUIRED`
- human response resumes task via continue flow
- refusal becomes `REJECTED` when appropriate

**Step 2: Implement the continuation path** Make continuation a first-class task
operation, not a hidden side-channel response.

**Step 3: Run focused tests**

```bash
deno test src/orchestration/client_test.ts src/orchestration/broker_test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/orchestration/broker.ts src/orchestration/client.ts src/orchestration/client_test.ts
git commit -m "feat: add canonical a2a continuation for human-input pauses"
```

---

## Phase 6 — Align network transport with the same semantics

### Task 6.1: Rework `BrokerClient` around task-oriented A2A HTTP/SSE

**Files:**

- Modify: `src/orchestration/client.ts`
- Modify: `src/orchestration/client_test.ts`
- Reference: `src/messaging/a2a/client.ts`
- Reference: `src/messaging/a2a/runtime_port.ts`

**Step 1: Write failing tests** Cover transport-independent behavior across:

- local adapter
- HTTP submit/get adapter
- SSE stream adapter

**Step 2: Split adapters by transport** Use separate local and HTTP-backed
adapters behind a common task-oriented interface.

**Step 3: Remove `pendingRequests` as the mental center** Network semantics must
be submit + stream/poll + continue/cancel, not request/response bookkeeping.

**Step 4: Run tests**

```bash
deno test src/orchestration/client_test.ts src/messaging/a2a/
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/orchestration/client.ts src/orchestration/client_test.ts
git commit -m "refactor: migrate broker client to task-oriented a2a transport"
```

---

## Phase 7 — Demote KV Queue after the canonical path works

### Task 7.1: Remove queue-based assumptions from runtime and setup paths

**Files:**

- Modify: `src/agent/runtime.ts`
- Modify: `src/cli/setup.ts`
- Modify: `src/agent/runtime_test.ts`
- Modify: `src/cli/setup_test.ts`

**Step 1: Write failing tests** Cover generated runtime/setup text and behavior
without queue-based claims.

**Step 2: Implement the minimal changes** Update runtime/setup wording and
assumptions so the system is clearly:

- HTTP-reactive
- task-oriented
- queue-independent as canonical model

**Step 3: Run tests**

```bash
deno test src/agent/runtime_test.ts src/cli/setup_test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/agent/runtime.ts src/cli/setup.ts src/agent/runtime_test.ts src/cli/setup_test.ts
git commit -m "refactor: remove queue-based assumptions from runtime setup"
```

### Task 7.2: Constrain KV Queue usage to optional broker optimization only

**Files:**

- Modify: `src/messaging/bus.ts`
- Modify: `src/orchestration/broker.ts`
- Modify: `src/messaging/bus_test.ts`
- Modify: `docs/architecture-distributed.md`

**Step 1: Write failing tests** Cover operation when KV Queue is absent or
disabled.

**Step 2: Reword and refactor** Make KV Queue an optional broker-internal
optimization only, not a conceptual requirement.

**Step 3: Run tests**

```bash
deno test src/messaging/bus_test.ts src/orchestration/broker_test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/messaging/bus.ts src/orchestration/broker.ts src/messaging/bus_test.ts docs/architecture-distributed.md
git commit -m "refactor: demote kv queue to optional broker optimization"
```

---

## Phase 8 — Remove stale language from docs and README

### Task 8.1: Unify all docs around the one true runtime story

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture-distributed.md`
- Modify: `docs/plan-post-adr008.md`
- Modify: `docs/adr-001-all-agents-in-sandbox.md`
- Modify: `docs/adr-008-agent-deploy-corrections.md`

**Step 1: Write a grep-driven cleanup checklist** Run:

```bash
cd /home/ubuntu/CascadeProjects/denoclaw
rg -n "KV Queue|BrokerMessage|process\(|agent_deliver|agent_send|agent_result|agent_response|request/response" README.md docs src
```

Use the output to remove stale conceptual language from docs.

**Step 2: Update docs** Add one canonical explanatory section wherever needed:

- A2A defines work
- worker protocol handles runtime plumbing
- transport varies by environment
- KV stores durable state and traces

**Step 3: Run lint/check**

```bash
deno task check
deno task lint
```

Expected: PASS.

**Step 4: Commit**

```bash
git add README.md docs/architecture-distributed.md docs/plan-post-adr008.md docs/adr-001-all-agents-in-sandbox.md docs/adr-008-agent-deploy-corrections.md
git commit -m "docs: unify runtime model around canonical a2a task semantics"
```

---

## Required test matrix

### 1. Local single-agent

- local submission becomes canonical A2A task
- result remains behaviorally unchanged
- task ids and context ids are emitted in traces

### 2. Local agent-to-agent

- agent A delegates to agent B
- worker pool routing preserves canonical task semantics
- peer policy still enforced

### 3. Human-input pauses

- approval request transitions task to `INPUT_REQUIRED`
- metadata identifies awaited input type
- human response resumes task
- refusal produces `REJECTED` when policy/user-denial semantics apply

### 4. Broker task persistence

- task created in KV
- transition rules enforced centrally
- terminal state protection preserved
- resume-after-pause behavior is durable

### 5. Transport independence

- same task logic works with:
  - local postMessage adapter
  - HTTP submit/get
  - SSE stream

### 6. No queue dependency

- runtime still works with KV Queue unavailable
- broker still routes via canonical A2A path

### 7. Replay / idempotence / reconnection

- duplicate submit does not duplicate work unexpectedly
- resumed stream does not corrupt terminal state
- continuation after restart preserves task identity

### 8. Tracing

- every task has a task id / context id trail
- subprocess or worker execution links back to the parent task

---

## Commands to run during execution

After each phase:

```bash
cd /home/ubuntu/CascadeProjects/denoclaw
deno task test
deno task check
deno task lint
```

For focused iteration:

```bash
deno test src/messaging/a2a/
deno test src/agent/
deno test src/orchestration/
```

---

## Migration order that will not lie to you

Do **not** start by deleting queue code or by writing generic transport
abstractions in a vacuum.

Do this instead:

1. document the strict boundary
2. freeze canonical A2A task invariants
3. propagate correlation ids
4. route local execution through canonical task semantics
5. shrink the worker protocol to infra-only
6. move broker operations to canonical task APIs
7. align HTTP/SSE transport to the same model
8. only then demote KV Queue everywhere else

This order changes the center of gravity without losing debuggability.

---

## Expected outcome

At the end of this plan:

- A2A is the dominant internal and external task contract
- the worker protocol still exists, but only for runtime plumbing
- approvals and pauses are visible truthfully in task state
- local and network execution share one lifecycle model
- KV is durable state, not magical transport
- broker↔agent flow no longer depends conceptually on KV Queue
- the codebase tells one coherent story instead of two partial ones
