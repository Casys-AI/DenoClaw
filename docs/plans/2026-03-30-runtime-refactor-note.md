# Runtime Refactor Note

**Date:** 2026-03-30 **Status:** Completed

## Why this note exists

Several runtime files are now too large and mix transport, auth, routing,
policy, and user-facing concerns:

- `src/orchestration/broker.ts`
- `src/orchestration/gateway.ts`
- `src/cli/setup.ts`
- `main.ts`

The goal is not stylistic cleanup. The goal is to make the runtime legible,
AX-safe, and easier to evolve without reintroducing ambiguous naming or hidden
mode inference.

## AX constraints

This refactor must preserve the repo's AX rules:

- Explicit over implicit: local vs deployed runtime must be obvious in names,
  module layout, and CLI text.
- Deterministic outputs: `--json`, `--yes`, and non-interactive flows must keep
  stable behavior while code moves.
- Discoverable commands: refactors must not hide runtime mode selection behind
  broad wrappers or "smart" inference.
- Safe defaults: transport/auth boundaries stay fail-fast; no fallback path
  should silently widen access or downgrade auth.
- Composable primitives: registries, routers, and transport helpers should be
  reusable modules, not buried inside god classes.

## Naming rules

These names should stay strict:

- `gateway` = local development runtime
- `broker` = deployed distributed control plane
- `tunnel` = external connector over the strict broker tunnel protocol
- `agent socket` = reserved name for a future dedicated deployed agent-to-broker
  channel; it is not a tunnel

Corollaries:

- A deployed broker flow must not be labeled `gateway`.
- A tunnel must not become a catch-all for deployed runtime channels.
- Shared code should use `runtime` or `orchestration` only when it genuinely
  supports both local and deployed modes.

## Refactor patterns

The refactor should prefer a small set of repeatable patterns:

### 1. Constructor DI with explicit deps bags

Use simple constructor injection for long-lived collaborators:

- registries
- transport adapters
- metrics
- storage-backed services

Avoid service locators and container-style magic. If a dependency matters to a
runtime invariant, it should be visible in the constructor or a named factory.

### 2. Stateful registries for mutable connection maps

Mutable runtime maps should not live inline in `BrokerServer` or `Gateway`. Use
focused registries with intent-revealing methods such as:

- `findReplySocket()`
- `findRemoteBrokerConnection()`
- `collectAdvertisedAgentIds()`

This keeps naming honest and makes tests inject or seed runtime state without
reaching into anonymous `Map` internals.

### 3. Pure route tables for protocol dispatch

HTTP and control-plane dispatch should move toward route tables or handler maps
instead of large inline `if`/`switch` chains spread across one file.

Good targets:

- federation HTTP handlers
- broker HTTP routes
- local gateway HTTP routes

### 4. Thin runtime orchestrators

`BrokerServer` and `Gateway` should own lifecycle and invariants, but delegate:

- connection lookup to registries
- message send rules to transport helpers
- route parsing to routers
- persistence concerns to storage helpers/services

### 5. Behavior-preserving extraction first

Before changing protocol or product behavior:

- extract helpers
- extract registries
- split route handlers
- add or move tests alongside the extracted seams

No refactor step should mix naming cleanup, behavior changes, and new product
scope in one patch.

## Target module split

### `main.ts`

Target split:

- `src/cli/entry.ts`
- `src/cli/help.ts`
- `src/runtime/start_local.ts`
- `src/runtime/start_broker.ts`

Rule:

- `main.ts` becomes a thin entrypoint only.

### `src/orchestration/broker.ts`

Target split:

- `src/orchestration/broker/server.ts`
- `src/orchestration/broker/http_router.ts`
- `src/orchestration/broker/tunnel_registry.ts`
- `src/orchestration/broker/task_dispatch.ts`
- `src/orchestration/broker/reply_dispatch.ts`
- `src/orchestration/broker/persistence.ts`

Rule:

- `BrokerServer` orchestrates collaborators; it does not own every route and
  every mutable map inline.

Current extraction in `codex/runtime-ax-broker-refactor`:

- `src/orchestration/broker/server.ts`
- `src/orchestration/broker/http_router.ts`
- `src/orchestration/broker/agent_registry.ts`
- `src/orchestration/broker/tunnel_registry.ts`
- `src/orchestration/broker/tunnel_upgrade.ts`
- `src/orchestration/broker/federation_runtime.ts`
- `src/orchestration/broker/task_dispatch.ts`
- `src/orchestration/broker/reply_dispatch.ts`
- `src/orchestration/broker/persistence.ts`
- `src/orchestration/broker/tool_dispatch.ts`

### `src/orchestration/gateway.ts`

Target split:

- `src/orchestration/gateway/server.ts`
- `src/orchestration/gateway/http_routes.ts`
- `src/orchestration/gateway/ws_routes.ts`
- `src/orchestration/gateway/dashboard.ts`

Rule:

- local gateway code stays visually and semantically separate from deployed
  broker code.

Current extraction in `codex/runtime-ax-broker-refactor`:

- `src/orchestration/gateway/server.ts`
- `src/orchestration/gateway/dashboard.ts`
- `src/orchestration/gateway/ws_routes.ts`
- `src/orchestration/gateway/http_routes.ts`

### `src/cli/setup.ts`

Target split:

- `src/cli/setup/providers.ts`
- `src/cli/setup/channels.ts`
- `src/cli/setup/broker_deploy.ts`
- `src/cli/setup/subhosting_publish.ts`
- `src/cli/setup/prompts.ts`

Rule:

- setup remains explicit and AX-friendly in both TTY and `--json` paths.

Current extraction in `codex/runtime-ax-broker-refactor`:

- `src/cli/deploy_api.ts`
- `src/cli/setup/providers.ts`
- `src/cli/setup/channels.ts`
- `src/cli/setup/agent.ts`
- `src/cli/setup/broker_deploy.ts`
- `src/cli/setup/subhosting_publish.ts`
- `src/cli/setup/prompts.ts`
- `src/cli/setup/status.ts`

## Main Worktree Delta Sync

To reduce merge risk with the dirty local `main` worktree, the refactor branch
now also absorbs the critical behavior changes that were only present there.

Already synced into this worktree:

- shared deploy credential resolution via `src/shared/deploy_credentials.ts`
- deploy naming helpers via `src/shared/naming.ts`
- deploy config fields in `src/config/types.ts`
- broker sandbox token lookup through shared credential helpers
- Deno Deploy CLI/API support via `src/cli/deploy_api.ts`
- Deno Deploy broker deploy flow in `src/cli/setup/broker_deploy.ts`
- Deno Deploy agent publish flow in `src/cli/setup/subhosting_publish.ts` and
  `src/cli/publish.ts`
- deployed agent runtime bootstrap via `src/agent/deploy_runtime.ts`
- dedicated agent socket protocol and transport via:
  - `src/orchestration/agent_socket_protocol.ts`
  - `src/orchestration/transport.ts`
- broker-side deployed agent routing support:
  - `/agent/socket`
  - `/agents/register`
  - endpoint persistence
  - HTTP wake-up before KV fallback
- regression tests covering the deployed agent registration and wake-up paths

Result:

- the refactor branch is no longer missing the most important deploy/runtime
  deltas from the dirty local worktree
- merge review can focus more on intentional overlap and less on accidental
  feature rollback

## Post-merge polish

After landing the refactor into the local checkpoint branch:

- internal CLI imports now use the canonical `src/cli/setup/mod.ts` module
- top-level orchestration exports now point at canonical server modules
- the canonical agent publish module is now `src/cli/setup/agent_publish.ts`
- the canonical broker HTTP route module is now
  `src/orchestration/broker/http_routes.ts`
- compatibility wrappers remain in place, but internal code no longer depends on
  them by default
- `src/orchestration/broker/server.ts` has since been reduced again by
  extracting:
  - `src/orchestration/broker/llm_proxy.ts`
  - `src/orchestration/broker/agent_message_router.ts`
  - slimmer federation wiring in
    `src/orchestration/broker/federation_runtime.ts`
  - HTTP/upgrade runtime bridging in `src/orchestration/broker/http_runtime.ts`
  - startup/shutdown coordination in
    `src/orchestration/broker/lifecycle_runtime.ts`
- current broker/federation/agent runtime file sizes are now:
  - `src/orchestration/broker/server.ts`: 499 lines
  - `src/orchestration/federation/service.ts`: 268 lines
  - `src/orchestration/federation/identity_manager.ts`: 82 lines
  - `src/agent/worker_entrypoint.ts`: 473 lines
  - `src/agent/worker_pool.ts`: 393 lines

## Priority order

### Phase 1

- codify naming rules
- extract the first broker registries/helpers
- keep tests green

### Phase 2

- split broker HTTP routing and reply/task dispatch

### Phase 3

- decompose gateway

### Phase 4

- split CLI entry/setup

## Definition of done

This refactor is successful when:

- deployed flows never say `gateway`
- mutable runtime maps live behind named collaborators
- broker vs local runtime paths are obvious from file layout
- AX behavior stays stable for `--json`, `--yes`, and non-interactive usage
- tunnels and future agent sockets are represented as different concepts

## Landing Strategy

The refactor now touches enough shared runtime files that it should be landed in
intentional slices instead of one unstructured merge.

Recommended landing sequence:

### Commit 1 — Runtime decomposition

- thin `main.ts`
- extract `src/runtime/*`
- extract `src/orchestration/broker/*`
- extract `src/orchestration/gateway/*`
- keep `src/orchestration/broker.ts` and `src/orchestration/gateway.ts` as
  compatibility re-exports

Goal:

- land the structural split and naming cleanup first
- make review focus on module boundaries and runtime invariants

### Commit 2 — CLI decomposition

- extract `src/cli/entry.ts`
- extract `src/cli/help.ts`
- extract `src/cli/init.ts`
- extract `src/cli/setup/*`
- keep `src/cli/setup.ts` and `src/cli/setup_steps/*` as compatibility shims

Goal:

- separate command routing from setup implementation
- preserve backward-compatible import paths while shrinking large files

### Commit 3 — AX guardrails and tests

- structured CLI errors for non-interactive setup flows
- suppress human-only deprecation output in `--json`
- CLI-focused tests for `--json`, `--yes`, and non-interactive behavior
- note/documentation updates

Goal:

- lock down deterministic AX behavior after the file split

### Local integration rule

Do not merge this work directly into a dirty local `main` worktree.

Before integration:

- checkpoint the current local development work on its own branch or stash
- integrate the refactor branch into a clean branch/worktree
- resolve overlap on:
  - `main.ts`
  - `src/cli/setup.ts`
  - `src/orchestration/bootstrap.ts`
  - `src/orchestration/broker.ts`
  - `src/orchestration/broker_test.ts`

Reason:

- these files overlap with ongoing local work and will create noisy conflicts if
  the runtime refactor is merged into a dirty tree

## Polish Backlog

The runtime refactor itself is complete. The items below are optional follow-up
polish and should be treated as a separate track.

### Priority A — post-merge cleanup

- migrate internal imports to canonical paths only
- align legacy filenames with their real semantics:
  - `src/cli/setup/subhosting_publish.ts`
  - any remaining `gateway` wording in deprecated compatibility shims
- remove compatibility wrappers once downstream imports stop relying on them:
  - `src/orchestration/broker.ts`
  - `src/orchestration/gateway.ts`
  - `src/cli/setup.ts`
  - `src/cli/setup_steps/*`
  - `src/orchestration/gateway/dashboard.ts`
  - `src/orchestration/gateway/http_routes.ts`
  - `src/orchestration/gateway/ws_routes.ts`
- decide whether `broker/http_router.ts` should also be renamed to
  `http_routes.ts` for symmetry with gateway

### Priority B — reduce remaining large files

- if desired, continue shrinking `src/orchestration/broker/server.ts` around
  message dispatch ergonomics only
- if desired, continue shrinking `src/orchestration/federation/service.ts`
  around link/control-plane wrappers only
- split `src/orchestration/federation/service.ts`
- split `src/agent/worker_entrypoint.ts`
- split `src/agent/worker_pool.ts`

### Priority C — stronger verification

- add broader CLI e2e coverage beyond current AX unit tests
- add transport/integration coverage for the deployed agent WebSocket path
- add integration coverage for dashboard HTTP routes that require KV
- add import-boundary checks for canonical runtime paths after wrapper removal
