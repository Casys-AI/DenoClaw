# ADR-008: Subhosting Architecture Corrections — Broker Orchestrates, Agents React

**Status:** Accepted **Date:** 2026-03-27

## Context

An audit of the official Deno Subhosting docs revealed fundamental errors in
our execution model. The existing architecture assumed that Subhosting agents
could run as long-lived daemons using `Deno.cron()` and `kv.listenQueue()`. In
practice, neither API works in Subhosting.

### Verified claims (official sources)

| Claim                                 | Verdict   | Source                                                                                        |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `Deno.cron()` blocked in Subhosting   | CONFIRMED | docs.deno.com/subhosting/api/ — _"Deno Cron and Queues do not currently work for Subhosting"_ |
| `kv.listenQueue()` blocked            | CONFIRMED | Same statement, same doc                                                                      |
| Isolates are not long-running         | CONFIRMED | Idle timeout 5 sec to 10 min, then SIGKILL                                                    |
| KV is not auto-isolated per deployment | CONFIRMED | KV databases are explicitly created and bound through the API                                 |
| API v1 sunset July 20, 2026           | CONFIRMED | Multiple official sources                                                                     |
| Workers inside Subhosting             | UNKNOWN   | Not documented and does not solve persistence                                                 |

### API v2 changes

|              | v1                         | v2                                         |
| ------------ | -------------------------- | ------------------------------------------ |
| Terminology  | Projects / Deployments     | **Apps / Revisions**                       |
| Fields       | camelCase                  | **snake_case**                             |
| Entry point  | `entryPointUrl`            | `config.runtime.entrypoint`                |
| Env vars     | object                     | array                                      |
| Status       | `pending`/`success`        | `queued`/`succeeded`                       |
| Max RAM      | 512 MB                     | **4 GB**                                   |
| CPU limits   | Per-request (50-200ms avg) | **No per-request limit**                   |
| New features | —                          | Labels, Layers, SSE logs, custom build steps |

## Affected code

### Critical (broken in Subhosting)

| File                          | Problem                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/agent/runtime.ts`        | `Deno.cron()` via CronManager + `kv.listenQueue()`. Daemon-style `start()`/`stop()` model.                      |
| `src/orchestration/client.ts` | Communication through `kv.enqueue()`/`kv.listenQueue()` plus `pendingRequests`, assuming a persistent process. |
| `src/cli/setup.ts`            | Generated entrypoint contains `Deno.cron()`, `listenQueue()`, fake `Deno.serve()` keep-alive, incomplete LLM cycle. |

### High priority (not aligned with the architecture)

| File                         | Problem                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `main.ts`                    | `AgentLoop` runs in-process, not behind `new Worker()`.  |
| `src/orchestration/gateway.ts` | `AgentLoop` inside HTTP handlers blocks the event loop. |
| `src/cli/setup.ts`           | Subhosting API v1 (`api.deno.com/v1`).                   |
| `src/orchestration/sandbox.ts` | Sandbox API v1.                                        |

### Test coverage

There are zero tests for AgentRuntime, BrokerClient, CronManager, or the
generated entrypoint.

## Decision

### Principle

> **The Broker orchestrates. The agent reacts. Code runs in Sandbox.**

In Subhosting, the agent is a pure HTTP server. It receives work by POST,
performs its computation, including multi-step LLM work, and either returns a
synchronous result (short task) or a `taskId` plus SSE stream (long task). The
Broker is the durable message store and cron dispatcher.

> **A2A over transport X, persisted in KV, correlated by task/context ids.**

### Three layers — Deploy and Local

| Role           | Deploy                              | Local                           |
| -------------- | ----------------------------------- | ------------------------------- |
| Orchestrator   | Broker (Deno Deploy)                | **Process** (main)              |
| Agent          | Subhosting (warm-cached V8 isolate) | **Worker** (`new Worker()`)     |
| Code execution | Sandbox (microVM)                   | **Subprocess** (`Deno.Command`) |

Multi-agent is the default mode, even in development. Every agent has a name,
never `"default"`.

### Communication — 3 layers

| Layer                | Role                                 | Local                              | Deploy                                     |
| -------------------- | ------------------------------------ | ---------------------------------- | ------------------------------------------ |
| **HTTP POST**        | Wake-up transport for A2A work       | Not required (workers stay alive)  | Only way to wake Subhosting                |
| **WebSocket**        | Continuous communication / optimization | `postMessage` (local WS equivalent) | Persistent WS while the agent is awake     |
| **BroadcastChannel** | Infra only (shutdown, config reload) | ✅ between workers                  | N/A (does not work cross-deployment)       |

In other words: **A2A over transport X, persisted in KV, correlated by
task/context ids.**

Deploy flow: HTTP POST wakes the agent → agent opens WS to Broker →
bidirectional communication → agent goes idle → WS dies → system falls back to
HTTP POST.

The agent sees a single interface (`AgentBrokerPort`). The dual mode exists in
infrastructure, not in agent code.

### Routing — the Broker is the universal router

All agent-to-agent communication goes through the Broker. The agent does not
know where the target is located.

| The agent wants to talk to... | The Broker does...                        |
| ----------------------------- | ----------------------------------------- |
| An agent in the same instance | `postMessage` (local) or WS (deploy)      |
| An agent in another instance  | Tunnel → remote Broker → WS to the agent  |
| Multiple agents (multicast)   | Fan-out using the same logic per target   |

`BroadcastChannel` is **not** used for inter-agent communication, only for
infra concerns such as shutdown and config reload.

### KV — store vs transport

**KV as storage: yes everywhere. KV as transport (`enqueue` / `listenQueue`):
local + Broker Deploy only.**

Two KV stores per agent:

- **Private KV** (`./data/<agentId>.db` locally, bound DB in deploy) for
  memory, sessions, and agent-specific A2A history
- **Shared KV** (`./data/shared.db` locally, bound DB shared across agents in
  deploy) for inter-agent messages, traces, routing, and cron schedules

Locally, KV queues work between workers because they share the same SQLite
store. In deploy, the Broker uses KV queues internally and pushes toward agents
over HTTP.

### Deploy communication

```
Deploy ↔ Subhosting = direct HTTP (same Deno platform, no tunnel)
Agent → Broker     : fetch() HTTP with OIDC auth
Broker → Agent     : HTTP POST (messages, cron triggers, A2A tasks)
Durability         : internal Broker KV Queues (Deploy)
```

### Long tasks — A2A task + SSE pattern

```
1. Broker POST /tasks → Agent
2. Agent returns 202 Accepted { taskId }
3. Agent runs the ReAct loop (LLM calls via fetch to the Broker)
4. Agent writes progress into KV + streams SSE on GET /tasks/{id}/events
5. Broker subscribes to SSE, re-emits to the caller, stores the final result
```

The existing A2A types in `src/messaging/a2a/types.ts` are the wire format
(`TaskState`, `TaskStatusUpdateEvent`).

### Cron — single dispatcher

`Deno.cron()` is statically extracted from the AST on Deploy. One cron
dispatcher reads agent schedules from KV and dispatches them over HTTP POST.

### Auth Agent → Broker — prefer OIDC

Use `@deno/oidc` when possible in Subhosting, since it runs on the same
platform as Deploy. The Broker verifies `org_id` + `app_id` in the JWT.
Fallbacks are Layers (v2) or invite tokens. Local mode uses no auth because
`postMessage` is internal.

### LLM — API key + OAuth, not CLI

The Broker uses `fetch()` with either an API key or an OAuth token, following
the same auth model as Claude CLI or Codex CLI but without `Deno.Command`.
Tunnels are only needed for the initial OAuth browser flow.

### Traces — through the Broker

Agent traces are sent back to the Broker over HTTP. The Broker writes them into
shared KV. The dashboard watches Broker KV through `kv.watch()`.

### Tunnels — mesh outside the platform

Tunnels connect systems that are **outside** the Deno platform: local machines
(tools, auth), VPS/GPU hosts (resources), and other Brokers (federation).
Deploy ↔ Subhosting does not need a tunnel.

## Consequences

- The architecture moves from "agent orchestrates, Broker routes" to
  **"Broker orchestrates, agent reacts"**
- Agent code is identical in local mode (Worker) and deploy mode (Subhosting)
- Durable state is centralized in the Broker, the only component allowed to use
  KV queues in deploy
- Existing A2A types become the native wire format between agent and Broker
- The three-layer model
  (Process/Worker/Subprocess ↔ Broker/Subhosting/Sandbox) becomes coherent
