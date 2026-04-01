# Agent Config / Workspace Source-of-Truth Cleanup Plan

**Date:** 2026-04-01 **Status:** Archived after review on 2026-04-01

## Review outcome

Review against `main` confirms that the core plan was implemented:

- docs and ADRs now distinguish broker-owned config from agent-owned workspace
  content
- broker/gateway config persistence now converges on the canonical
  `["agents", agentId, "config"]` namespace
- deploy boot now fetches canonical config from the broker
- agent WebSocket registration no longer carries full config payloads
- `soul.md` now syncs with `skills/*` and `memories/*` into workspace KV
- generated deploy entrypoints no longer carry durable agent config payloads
- verification passed at implementation time with `deno task test`,
  `deno task lint`, and `deno task check`

Residual follow-ups remain deliberately outside this archived plan:

- legacy fallback reads still exist in `AgentStore` for migration safety
- `AgentEntry.systemPrompt` still exists as a compatibility field even though
  publish strips it from broker-owned config

So this plan is archived as implemented, with only small cleanup follow-ups
left if and when the migration window is formally closed.

## Why this plan exists

The current deploy model works, but it still mixes multiple ownership models for
agent state:

- `agent.json` behaves like broker-owned control-plane config
- `soul.md`, `skills/*`, and `memories/*` behave like agent workspace content
- deploy boot still embeds resolved config in the generated entrypoint
- two different KV layouts are currently used for agent config persistence

This is no longer primarily an implementation gap. It is a source-of-truth
cleanup problem.

## Decisions captured so far

### 1. `agent.json` should be treated as control-plane config

Current evidence in the code:

- publish registers agent config back to the broker
- broker persists agent config in KV
- broker uses persisted agent config for real operational decisions such as tool
  permission enforcement

Accepted direction:

- local workspace remains the authoring surface for `data/agents/<id>/agent.json`
- in deploy, the canonical runtime copy of that config lives on the broker
- `agent.json` should not be modeled as part of the agent's private workspace KV

Reason:

- the broker is already the control plane
- sandbox policy, peers, and acceptance rules are broker-governed concerns
- duplicating that config into agent-private KV would blur the boundary instead
  of clarifying it

### 2. `soul.md` belongs to the agent workspace

Accepted direction:

- `soul.md` should live with `skills/*` and `memories/*` as workspace content
- in deploy, it should be loaded from the agent's private workspace KV

Reason:

- it is part of what the agent is, not part of broker routing/policy
- it changes the agent's prompt identity, not broker control-plane behavior

### 3. `skills/*` and `memories/*` are already on the right side

Current state:

- deploy runtime already loads `skills/*` from workspace KV
- deploy file tools already route workspace reads/writes to KV
- publish already syncs `skills/*` and `memories/*`

So the main remaining workspace gap is `soul.md`, not the whole workspace model.

## Current structural problems

### 1. The same agent config exists in too many places

Today agent config may exist in all of these forms:

- local workspace file: `data/agents/<id>/agent.json`
- broker KV registry
- generated deploy entrypoint payload
- optional WebSocket register message payload

Consequences:

- it is unclear which copy is authoritative at deploy runtime
- config drift can be masked by publish-time embedding
- transport registration is carrying more state than necessary

### 2. Two KV namespaces are used for agent config

There is an actual persistence split today:

- gateway `AgentStore` uses `["config", "agents", agentId]`
- broker registry uses `["agents", agentId, "config"]`

This is the highest-priority cleanup item because it creates two durable stores
for the same concept.

### 3. ADR-018 currently mixes workspace content and control-plane config

The current ADR-018 scope implies that all of this belongs to one KV-backed
workspace contract:

- `agent.json`
- `soul.md`
- `skills/*`
- `memories/*`

That is too broad. The deploy architecture is cleaner if it distinguishes:

- broker-owned config
- agent-owned workspace content

## Target model

### Broker-owned control plane

Canonical in deploy:

- agent config derived from `agent.json`
- endpoint registration
- routing policy
- peer access rules
- sandbox policy / privilege elevation policy

Authoring source:

- `data/agents/<id>/agent.json`

Deploy canonical store:

- one broker KV registry namespace only

### Agent-owned workspace

Canonical in deploy:

- `soul.md`
- `skills/*`
- `memories/*`

Authoring source:

- `data/agents/<id>/`

Deploy canonical store:

- agent-private workspace KV

### Bootstrap model

Deploy entrypoint should contain only the minimum bootstrap state required to
start the runtime safely:

- `agentId`
- broker URL / auth bootstrap
- optional workspace snapshot used to seed agent-private KV

It should not remain the durable source of truth for agent config.

## Correction plan

### Phase 1. Fix the architectural contract first

Update the docs so they match the intended ownership split:

- revise ADR-018 so `agent.json` is removed from workspace KV scope
- explicitly add `soul.md` to the deploy workspace KV contract
- align ADR-014 hot-reload language with the split between broker-owned config
  and agent-owned workspace content

Deliverable:

- architecture docs no longer imply that `agent.json` belongs in private
  workspace KV

### Phase 2. Unify the broker-side config store

Introduce one shared broker/gateway agent config store and remove the current
namespace split.

Recommended canonical KV key:

- `["agents", agentId, "config"]`

Reason:

- it already matches the active broker path
- it avoids a second migration toward a new shape

Implementation direction:

- make gateway CRUD use the same underlying store abstraction as the broker
- add temporary fallback reads from the legacy `["config", "agents", agentId]`
  namespace if needed during migration
- stop writing new data to the legacy namespace

Deliverable:

- one durable KV location for agent config

### Phase 3. Remove config duplication from transport registration

The agent WebSocket registration flow should not be a second config
synchronization mechanism.

Accepted direction:

- keep `agentId`
- keep endpoint only if the broker still needs the runtime to advertise it
- stop sending full `config` in the socket register payload once broker config
  fetch is in place

Deliverable:

- registration protocol carries identity, not control-plane source data

### Phase 4. Make deploy runtime fetch canonical config from the broker

Replace the current "embedded config is the runtime config" model with a broker
config lookup during boot.

Accepted direction:

- deploy runtime boots with `agentId`
- runtime fetches canonical agent config from the broker before starting the
  conversation loop
- embedded config is reduced to bootstrap fallback only, then removed

This is the key step that collapses the duplicate source of truth between:

- entrypoint payload
- broker KV

Deliverable:

- broker KV becomes the canonical deploy-time config source

### Phase 5. Move `soul.md` onto the same workspace path as other agent content

Complete the workspace deploy model by treating `soul.md` like the rest of the
workspace.

Implementation direction:

- publish sync includes `soul.md`
- workspace KV helpers support it explicitly
- deploy runtime loads `soul.md` from workspace KV rather than relying on
  `AgentEntry.systemPrompt`

Deliverable:

- `soul.md`, `skills/*`, and `memories/*` share one coherent deploy workspace
  model

### Phase 6. Reduce type-level ambiguity

`AgentEntry` currently mixes control-plane and runtime-prompt concerns.

Accepted direction:

- either split the type into broker config vs runtime config
- or keep the type temporarily but de-emphasize `systemPrompt` as a control-plane
  field

Recommended outcome:

- long-term separation between:
  - control-plane agent config
  - workspace prompt/content model

Deliverable:

- the type system reflects the ownership split instead of hiding it

### Phase 7. Add migration and verification coverage

Before removing old paths, add:

- KV migration coverage for the legacy gateway namespace
- deploy boot test proving runtime reads config from broker store
- workspace test proving `soul.md` is loaded from workspace KV
- regression coverage for publish sync behavior

Verification bar for the implementation pass:

- `deno task test`
- `deno task lint`
- `deno task check`

## Recommended execution order

1. Fix the docs and ownership model.
2. Unify the broker/gateway config store.
3. Add broker-backed config fetch at deploy boot.
4. Remove config from socket registration.
5. Add `soul.md` to workspace KV sync/load path.
6. Clean up types and remove obsolete embedding paths.
7. Remove legacy KV fallback once migration is complete.

## Non-goals for this cleanup

- redesigning the entire local workspace authoring flow
- changing the broker-first ingress model
- moving conversation history out of its current memory backend
- introducing bidirectional workspace sync semantics beyond the current publish
  model

## Bottom line

The main correction is not "put everything in KV."

It is:

- put broker-owned config in one canonical broker store
- put agent-owned content in one canonical workspace store
- stop using publish-time embedding and transport registration as hidden extra
  sources of truth
