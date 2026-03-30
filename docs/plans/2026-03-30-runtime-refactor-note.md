# Runtime Refactor Note

**Date:** 2026-03-30 **Status:** Proposed

## Why this note exists

Several runtime files are now too large and mix multiple responsibilities:

- `src/orchestration/broker.ts` — 2233 lines
- `src/orchestration/gateway.ts` — 840 lines
- `src/cli/setup.ts` — 607 lines
- `main.ts` — 532 lines

This is already creating two concrete problems:

1. `gateway` vs `broker` naming is inconsistent across code, docs, and CLI text.
2. New deploy work is being added into god files, which makes transport, auth,
   and runtime behavior harder to reason about.

The goal is not to refactor for style. The goal is to make the runtime legible,
deploy-safe, and easier to evolve.

## Naming rules

These names should become strict:

- `gateway` = local development runtime
- `broker` = deployed distributed control plane
- `agent socket` = deployed agent <-> broker runtime channel
- `tunnel` = external machine or external runtime connector

Corollaries:

- A deployed agent is not a tunnel.
- A deploy target must say `broker`, not `gateway`.
- Local dashboard/UI language may still talk to the local gateway.
- Shared code should say `runtime` or `orchestration` when it truly supports
  both modes.

## Architectural direction

We should keep an OOP-friendly shape, but avoid huge god classes. That means:

- classes own lifecycle and invariants
- routers, registries, and protocol helpers are extracted into focused modules
- mode-specific behavior is explicit instead of hidden behind broad conditionals
- transport and auth contracts are modeled as interfaces

This also needs to stay AX-friendly:

- CLI commands remain explicit and discoverable
- `--json` and non-interactive paths do not depend on hidden mode inference
- user-facing messages must consistently distinguish local vs deployed runtime

## Target module split

### `main.ts`

Current issue:

- mixes CLI parsing, help text, local runtime boot, deployed runtime boot, and
  compatibility aliases

Target split:

- `src/cli/entry.ts` — argument parsing and command dispatch
- `src/cli/help.ts` — help text and examples
- `src/runtime/start_local.ts` — local gateway boot
- `src/runtime/start_broker.ts` — deployed broker boot
- `src/runtime/start_repl.ts` — single-agent REPL path if kept

Rule:

- `main.ts` should become a thin entrypoint only

### `src/orchestration/broker.ts`

Current issue:

- owns HTTP routing, WebSocket upgrades, tunnel registry, agent routing, auth
  checks, persistence helpers, federation endpoints, task flow, and reply
  dispatch

Target split:

- `src/orchestration/broker/server.ts` — `BrokerServer` lifecycle only
- `src/orchestration/broker/http_router.ts` — request dispatch
- `src/orchestration/broker/agent_socket_registry.ts` — connected deployed
  agents
- `src/orchestration/broker/tunnel_registry.ts` — external tunnels only
- `src/orchestration/broker/agent_routes.ts` — `/agent/socket`,
  `/agents/register`
- `src/orchestration/broker/federation_routes.ts` — federation HTTP endpoints
- `src/orchestration/broker/task_dispatch.ts` — route task/message to agent
- `src/orchestration/broker/reply_dispatch.ts` — send replies back to peers
- `src/orchestration/broker/persistence.ts` — broker KV reads/writes

Rule:

- `BrokerServer` should orchestrate collaborators, not implement every endpoint
  inline

### `src/orchestration/gateway.ts`

Current issue:

- local-only concerns are bundled with HTTP routes, WS handling, dashboard
  integration, and worker lifecycle

Target split:

- `src/orchestration/gateway/server.ts` — `Gateway` lifecycle
- `src/orchestration/gateway/http_routes.ts` — local HTTP API
- `src/orchestration/gateway/ws_routes.ts` — local UI WebSocket path
- `src/orchestration/gateway/dashboard.ts` — dashboard composition
- `src/orchestration/gateway/worker_runtime.ts` — local worker interactions

Rule:

- local gateway code must stay clearly separated from deployed broker code

### `src/cli/setup.ts`

Current issue:

- mixes provider setup, channel setup, broker deploy, agent publish preparation,
  prompts, and user messaging

Target split:

- `src/cli/setup/providers.ts`
- `src/cli/setup/channels.ts`
- `src/cli/setup/broker_deploy.ts`
- `src/cli/setup/agent_publish.ts`
- `src/cli/setup/prompts.ts`

Rule:

- setup flows should compose reusable units rather than growing one wizard file

## Refactor constraints

These constraints matter more than cosmetic cleanup:

- Do not reintroduce ambiguous `gateway` wording for deployed flows.
- Do not merge deployed agent sockets into the semantic `tunnel` model.
- Prefer extracting pure helpers and registries before changing behavior.
- Keep public protocol types stable while moving files.
- Add or update tests whenever routing logic moves.

## Priority order

### Phase 1: naming and boundaries

- fix the most misleading docs and CLI messages
- make deploy boot path always say `broker`
- introduce dedicated folders for `broker/` and `gateway/` internals without
  changing behavior

### Phase 2: broker decomposition

- extract HTTP router
- extract agent socket registry
- extract tunnel registry
- extract task/reply dispatch

### Phase 3: gateway decomposition

- separate local UI routes from worker runtime
- move dashboard composition out of the gateway core

### Phase 4: CLI decomposition

- split `main.ts`
- split `setup.ts`
- align help text and deprecation aliases with the new naming rules

## Definition of done

This refactor is successful when:

- deploy-related code never uses `gateway` for the distributed runtime
- `broker.ts` is no longer a monolith
- local and deployed runtime paths are obvious from file layout alone
- CLI text is consistent for humans and for machine-readable AX flows
- agent sockets and tunnels are represented as different concepts in code
