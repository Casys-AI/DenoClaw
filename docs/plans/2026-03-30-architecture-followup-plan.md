# Architecture Follow-up Plan

**Date:** 2026-03-30 **Status:** In Progress

## Why this plan exists

The runtime refactor is largely complete and validated.

The remaining problems are no longer primarily about file size. They are about:

- runtime paths that still do not validate the same invariants
- multiple sources of truth for the same concept
- observability read models that still treat KV like a raw event log
- domain boundaries that are cleaner than before, but not fully closed

This plan captures the next architectural cleanup pass.

## Decisions captured so far

### 1. Human ingress should converge on one canonical boundary

Accepted direction:

- `channel_ingress` should become the real boundary for human-originated
  messages
- local mode and deployed mode should exercise the same canonical task ingress
  semantics as much as practical

Reason:

- today local mode still bypasses canonical task ingress in places and talks
  directly to `WorkerPool`
- that means local validation does not faithfully cover persisted task flow,
  continuation, or `INPUT_REQUIRED`

### 2. `shared` should be truly shared

Accepted direction:

- `src/shared` should contain only genuinely cross-domain contracts and helpers
- it should not act as a convenience barrel for re-exporting agent or
  orchestration domain types

Reason:

- a “shared kernel” only helps if it enforces a real boundary
- otherwise it becomes a leak point that makes domain ownership ambiguous

### 3. Agent source of truth must be reduced to one canonical model

This is the biggest structural ambiguity still open.

Current state:

- local runtimes still read `config.agents.registry`
- the CLI reads `workspace + config.agents.registry`
- publish reads only the workspace

That is the current double source of truth.

## What “double source of truth” means here

The same concept, “the set of declared agents”, exists in two different stores:

1. workspace files
   - `./agents/<id>/agent.json`
   - `./agents/<id>/soul.md`

2. config registry
   - `config.agents.registry`

Both stores are still read and written by different paths.

Consequences:

- an agent can be publishable but not visible to a local runtime
- an agent can exist in config but not in the workspace
- create/delete flows must keep two stores in sync manually
- migrations become fragile because drift is structurally possible

Recommended resolution:

- make the workspace the canonical source of truth for declared agents
- treat `config.agents.registry` as a temporary migration surface only
- stop writing new agent state into `config.agents.registry`
- eventually remove runtime dependence on it

Reason:

- the workspace already holds the richer, more explicit representation
- publish already treats the workspace as canonical
- the config registry is now mostly legacy compatibility state

## Review findings to address

### Immediate blockers that remain valid under ADR-017

- `shell.mode = "direct"` currently over-promises what it prevents
  - alternate shell entrypoints such as `/bin/sh -c`, `dash -c`, and wrapper
    forms can still pass current detection
  - redirection-only syntax is also not fully captured by the current guard
  - either tighten detection to match the documented contract, or narrow the
    documented promise

- `AgentRuntimeCapabilities` currently projects the wrong shell model
  - shell availability is derived from `run` permission only
  - exec mode is derived from `execPolicy.security`, not from
    `sandbox.shell.mode`
  - `sandbox.shell.enabled` is ignored
  - consequence: the prompt-level planning summary can advertise a shell shape
    that does not match actual runtime behavior
  - fix the projection, prompt summary, and capability fingerprint together

- relay trust model must be explicit
  - current relay execution trusts broker-side preflight and does not reapply
    the shared exec-policy guard locally
  - decide one of:
    - relay is intentionally a trusted broker extension, and document that
      contract clearly
    - relay must enforce the same guard locally, and route execution through it
  - do not keep the current half-state where the design text implies
    centralization but relay semantics still depend on trust in the caller

- `shell.enabled` consistency should be audited explicitly
  - current mainline flows do propagate shell config, but there are still
    low-level paths that instantiate `ShellTool` directly or execute tools
    without obviously carrying the same shell config surface
  - audit local no-backend paths, relay-local execution, and any direct
    `ToolRegistry` / `ShellTool` instantiation paths
  - decide whether `shell.enabled = false` is guaranteed everywhere, or only on
    broker/sandbox-governed flows
  - if the guarantee is universal, add tests and close any remaining holes
  - if the guarantee is scoped, narrow the user-facing docs accordingly

### ADR-017 migration debt to close explicitly

- legacy command-approval vocabulary still lingers after the privilege elevation
  migration
  - `ask`, `askFallback`, and `allowAlways` still appear in config types,
    defaults, docs, and some tests
  - the shared backend guard is now static-policy only, so those fields no
    longer describe the real enforcement path
  - ADR-017 makes this compatibility residue, not target-state behavior
  - near-term action:
    - remove dead command-approval semantics from docs/schema/types where
      possible
    - keep only minimal parsing compatibility until final cleanup lands

- explicit elevation-channel availability is still not modeled separately from
  broker support
  - today resumability is effectively gated by `privilegeElevation.supported`,
    not by a separate “operator channel available” signal
  - if we need a stronger distinction later, add it as a first-class broker
    capability rather than reintroducing command-approval fallbacks

### Process / verification follow-up

- canonical `deno task test` coverage drifted
  - `deno task test` now targets `src/` only
  - `README.md` and `AGENTS.md` still describe it as the default verification
    bar
  - resolve this one way or the other:
    - restore repo-wide default coverage, or
    - keep the narrower task and update docs/CI expectations consistently

## Progress snapshot

### Sandbox/runtime hardening started

Current state from the ADR-017-aligned cleanup pass:

- `shell.mode="direct"` is now hardened around a shared
  `requiresSystemShell(...)` detection path
- direct mode now rejects more shell-composition forms consistently, including:
  - wrapper forms such as `env sh -c` and `busybox sh -c`
  - interpreter path forms such as `/bin/sh -c`
  - direct redirection syntax in the command string
- direct mode still allows an explicit interpreter as a normal direct binary
  when it is not delegating inline shell composition, for example
  `bash ./script.sh`
- `AgentRuntimeCapabilities` now separates:
  - shell execution mode
  - shell policy mode instead of conflating both into `execPolicy.security`
- the capability projection now reflects:
  - `sandbox.shell.enabled`
  - `sandbox.shell.mode`
  - a capability fingerprint that changes with shell configuration
- user-facing shell docs were tightened to match the current direct/system-shell
  contract more closely
- verification for this slice is green:
  - `deno task check`
  - `deno task lint`
  - `deno task test`

Remaining work in this slice:

- decide the relay trust model explicitly and encode that contract in docs/code
- audit whether `shell.enabled = false` is guaranteed on every low-level path or
  only on broker/sandbox-governed flows
- decide whether to keep the legacy command-approval compatibility path working
  end-to-end during migration, or remove it faster under ADR-017

### Track 1 started

Current migration state:

- local gateway traffic now enters through `channel_ingress` instead of calling
  `WorkerPool.send(...)` directly
- `/chat` and `/ws` now submit canonical channel messages through the same seam
- local single-agent runtime now uses in-process `channel_ingress` both for
  console/bus messages and for one-shot `denoclaw agent -m ...`
- local ingress persists channel-backed tasks through `TaskStore` and exposes
  the same submit/get/continue shape as broker ingress
- the shared channel-to-A2A task message mapping now lives in
  `src/orchestration/channel_ingress/task_message.ts`
- local ingress keeps route-level request metadata, including local `model`
  override, so the move to `channel_ingress` does not silently drop existing CLI
  or `/chat` behavior
- gateway channel handling now resolves to the only running agent when there is
  exactly one, instead of requiring every built-in channel to inject
  `metadata.agentId`

Remaining work in Track 1:

- introduce an explicit ingress routing policy layer for the multi-agent case,
  because built-in channels own transport but should not own higher-level route
  selection themselves
- stop treating “one message -> one owner” as a universal invariant:
  - Telegram can stay `direct`
  - shared Discord scopes may legitimately be `broadcast`
- move routing policy out of agent-local config and into ingress-scope policy
- replace the temporary `message.metadata.agentId` compatibility fallback with
  explicit route resolution owned by an ingress router
- decide whether the broker HTTP ingress should also interpret route-level model
  metadata, or whether model override remains a strictly local concern
- add at least one higher-level smoke path that exercises channel submit then
  task continuation end-to-end from the local side

### Track 2 started

Current migration state:

- `saveConfig()` no longer persists the derived agent registry by default
- `getConfig()` / `getConfigOrDefault()` remain the resolved runtime read path
- `getPersistedConfigOrDefault()` exists for legacy migration-only reads
- `denoclaw agent create` now writes canonical state to the workspace and only
  cleans matching legacy config entries instead of creating new registry state
- `denoclaw agent delete` now removes both workspace state and matching legacy
  config residue when present
- runtime-facing code is starting to read agent declarations through a resolved
  registry helper instead of reaching straight into `config.agents.registry`
- `WorkerPool` now owns a dedicated runtime agent registry, instead of mutating
  the resolved config object to track live agents
- workers now receive a dedicated agent-registry snapshot during `init`,
  separate from global config defaults/providers/tools

Remaining work in Track 2:

- make the legacy fallback more explicit in runtime-facing code
- stop referring to `agents.registry` as if it were canonical
- decide whether hot-add/remove should actively re-sync registry snapshots to
  already-running workers, or whether a fresh worker start is sufficient

### High priority

- agent declaration state still exists in both workspace and config
- federation latency aggregation stores unbounded `latencySamples` in KV
- `/tasks/observations` does not reliably return the most recent entries

### Medium priority

- telemetry queries still depend on broad KV scans
- `AgentMetrics.lastActivity` is synthesized at read time instead of persisted
- worker shutdown semantics are split between explicit worker cleanup and blunt
  `terminate()`
- `Gateway` still owns part of channel composition instead of receiving it
- broker tool-execution default wiring exists in more than one place
- `shared/types.ts` still leaks domain types through re-exports

### Low priority

- compatibility wrappers still leave multiple public import paths
- channel startup is too fail-open for operator confidence

## Execution order

### Track 1 — Canonical human ingress

Goal:

- make local and deployed human message flow use the same task ingress model

Primary modules:

- `src/orchestration/channel_ingress/*`
- `src/orchestration/gateway/server.ts`
- `src/orchestration/broker/http_routes.ts`
- `src/runtime/start_agent.ts`
- `src/messaging/channels/*`

Target outcome:

- local runtime uses `InProcessBrokerChannelIngressClient` or equivalent seam
- deployed runtime uses `HttpBrokerChannelIngressClient`
- direct `workerPool.send(...)` ingress paths stop being the primary behavior
- continuation and `INPUT_REQUIRED` semantics are validated through the same
  conceptual boundary in both modes
- Telegram can stay on simple `direct` ingress
- shared-channel routing is explicit instead of being faked through a single
  universal owner rule

Acceptance:

- local ingress tests cover the same submit/get/continue model as broker ingress
- no new human ingress path relies on implicit `message.metadata.agentId` beyond
  the temporary compatibility shim tracked above
- shared-channel multi-agent routing has an explicit UX rule, not an accidental
  fallback

### Track 2 — Canonical agent source of truth

Goal:

- make the workspace the single canonical declared-agent store

Primary modules:

- `src/cli/agents.ts`
- `src/runtime/start_local.ts`
- `src/runtime/start_agent.ts`
- `src/cli/publish.ts`
- `src/config/loader.ts`
- `src/agent/workspace.ts`

Target outcome:

- runtime reads agent declarations from workspace-derived registry
- create/delete flows stop writing new canonical state into
  `config.agents.registry`
- config registry becomes migration-only compatibility state, then removable

Acceptance:

- one agent list path for local runtime, CLI, and publish
- explicit tests for migration from legacy config-only agents

### Track 3 — Observability read model cleanup

Goal:

- stop using raw KV scans as the primary dashboard/query model

Primary modules:

- `src/telemetry/metrics.ts`
- `src/telemetry/metrics_queries.ts`
- `src/telemetry/traces/*`
- `src/orchestration/monitoring.ts`
- `src/agent/worker_pool_observability.ts`
- `src/orchestration/federation/adapters/kv_adapter_stats.ts`

Target outcome:

- `lastActivity` is persisted from real runtime signals
- `/tasks/observations` returns actually recent observations
- metrics and traces expose lighter-weight indexed or pre-aggregated reads
- federation latency aggregation uses a bounded representation instead of
  unbounded `latencySamples`

Acceptance:

- observation ordering is deterministic and tested
- `lastActivity` reflects real activity, not request time
- hot dashboard endpoints no longer require whole-prefix scans for common reads

### Track 4 — Boundary hardening

Goal:

- close the remaining architectural leaks after the three core tracks above

Primary modules:

- `src/shared/types.ts`
- `src/shared/import_boundaries_test.ts`
- `src/orchestration/bootstrap.ts`
- `src/orchestration/broker/server.ts`
- `src/agent/worker_pool_lifecycle.ts`
- `src/agent/worker_entrypoint.ts`

Target outcome:

- `shared` only exports truly shared contracts
- broker default tool-execution wiring lives in one place
- worker shutdown has one coherent lifecycle contract
- compatibility wrappers can be reduced further once import usage shrinks

## Recommended implementation strategy

Do not attempt this as one mega-patch.

Recommended sequence:

1. Track 2 first because agent truth affects CLI, local runtime, and publish
   simultaneously
2. Track 1 second because ingress should target the canonical agent registry
   model
3. Track 3 third because observability cleanup is easier once runtime paths are
   stable
4. Track 4 last because boundary hardening is safer after the major read/write
   paths settle

## Non-goals

- no large-scale folderization pass for its own sake
- no new protocol redesign unless required by Track 1
- no broad renaming pass that mixes semantics, structure, and behavior changes

## Merge risk notes

The riskiest files for future overlap are:

- `src/cli/agents.ts`
- `src/runtime/start_local.ts`
- `src/runtime/start_agent.ts`
- `src/orchestration/gateway/server.ts`
- `src/orchestration/broker/http_routes.ts`
- `src/telemetry/metrics_queries.ts`
- `src/orchestration/federation/adapters/kv_adapter_stats.ts`

If these tracks are implemented, prefer small sequential commits and narrow test
reruns per track instead of another wide refactor batch.
