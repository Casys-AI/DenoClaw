# Implementation Plan — Post ADR-008

**Date:** 2026-03-27

## Phase 1 — Local multi-agent workers ✅ DONE

- [x] WorkerPool spawn/routing/shutdown with typed protocol
- [x] Worker entrypoint (`init`, process, shutdown via `BroadcastChannel`)
- [x] Every agent has a name (`--agent` required, no `"default"`)
- [x] Private KV per agent (`./data/<agentId>.db`) via Memory `kvPath`
- [x] Gateway accepts `agentId` in `/chat` and WebSocket
- [x] `AgentError` structured error type
- [x] Review + fixes (addEventListener, init timeout, ready check, Map drain)
- [x] Monitoring endpoints (`/stats`, `/agents`, `/cron`) + `MetricsCollector` DI
- [x] `WorkerPoolCallbacks` (`onWorkerReady`, `onWorkerStopped`)
- [x] Fresh handler slot in `GatewayDeps` (future dashboard)
- [x] End-to-end test OK (Worker + Ollama Cloud)

## Phase 1.5 — A2A routing + shared KV + observability ✅ DONE

- [x] `SendToAgentTool` — A2A tool with injected callback
      (transport-agnostic)
- [x] Worker protocol extended (`run`, `peer_deliver`, `peer_result`,
      `peer_response`, `task_started`, `task_completed`, `task_observe`)
- [x] `WorkerPool` A2A routing with peer checks
      (`peers` / `acceptFrom` closed by default)
- [x] Workers no longer write to shared KV directly; they emit messages and the
      main process writes instead (deploy-compatible)
- [x] Observability types moved into `shared/`
      (`TaskObservationEntry`, `AgentStatusEntry`, etc.)
- [x] Gateway routes: `/tasks/observations`, `/agents/:name/task`,
      `/.well-known/agent-card.json`
- [x] KV watch SSE extended with `task_observation` events
- [x] Naming normalized: `task_observations` KV,
      `task_observation_update` sentinel
- [x] `AgentCard` URL aligned with the real endpoints
- [x] `SendToAgentTool` preserves structured errors
      (`DenoClawError` passthrough)
- [x] `SSE controller.close()` + `deno.json --unstable-cron`
- [x] 83 tests, `check`, and `lint` OK

## Phase 2 — Deploy / Subhosting

### Workstream 2.1 — BrokerClient HTTP mode ✅ DONE

- [x] Extracted `BrokerTransport` interface (`src/orchestration/transport.ts`)
- [x] `KvQueueTransport` — local implementation (KV Queue)
- [x] `BrokerClient` with pluggable transport (`AgentBrokerPort`)
- [ ] HTTP/SSE transport for deploy mode (still pending)

### Workstream 2.2 — HTTP AgentRuntime ✅ DONE

- [x] `AgentRuntime` with reactive `Deno.serve()` (`src/agent/runtime.ts`)
- [x] Short tasks: synchronous HTTP response
- [x] Long tasks: `task_submit` / `task_continue` (A2A pattern)

### Workstream 2.3 — Agent → Broker OIDC auth

- Prefer `@deno/oidc`
- Fallback: Layers (v2) / invite token

### Workstream 2.4 — Cron dispatcher

- One static `Deno.cron()` with KV-backed schedule store

### Workstream 2.5 — API v2

- Deadline: July 20, 2026

### Workstream 2.6 — Subhosting entrypoint

- `Deno.serve()` HTTP handler

### Workstream 2.7 — Tests

- AgentRuntime, BrokerClient, CronManager

## Identified design debt (reviews)

| Issue                                                                      | Priority | Ref          |
| -------------------------------------------------------------------------- | -------- | ------------ |
| WorkerPool does too much — extract `PeerPolicy` and `PendingMap`           | Medium   | Arch review  |
| `Gateway.handleHttp` = 230 unstructured lines — extract a router           | Medium   | Arch review  |
| Agent message naming — consider an outbound/inbound pattern                | Low      | Arch + Codex |
| Endpoints are not very RESTful                                             | Low      | Codex naming |
| Telemetry KV keys still use `a2a` prefix (protocol dimension; acceptable)  | Low      | Codex        |
| Dashboard islands do not yet pass the auth token                           | Medium   | Codex arch   |

## Decisions taken

| Topic                                 | Decision                                                      |
| ------------------------------------- | ------------------------------------------------------------- |
| **KV Queues locally**                 | Keep them. HTTP only for Subhosting.                          |
| **3-layer communication**             | HTTP (wake) + WS (perf) + BC (infra only).                    |
| **Routing = Broker**                  | All agent↔agent communication goes through the Broker.        |
| **Agent never does `kv.watch()`**     | Only the Broker watches. Agents only read/write.              |
| **Workers do not write shared KV**    | They emit messages; the main process writes. Deploy-compatible. |
| **OAuth LLM**                         | Lower priority. Ollama Cloud API by default.                  |
| **Prefer OIDC auth**                  | OIDC everywhere except Sandbox and local mode.                |
| **Multi-agent = default**             | Always multi-agent. `--agent` is required.                    |
| **Subhosting API v2**                 | Mandatory. Deadline July 20, 2026.                            |
