# AX (Agent Experience) Compliance Review

Review date: 2026-04-02
Scope: Full `src/` + `web/` against the 9 AX principles from `AGENTS.md`
Method: 4 parallel review agents (orchestration, agent runtime, messaging/A2A, error patterns)

> Cross-referenced against `01-security.md` through `07-type-design.md` — duplicates
> are marked `(see XX-NN)` and not counted in the totals.

---

## Stats

| Principle | CRITICAL | HIGH | MEDIUM | LOW | Total |
|-----------|:---:|:---:|:---:|:---:|:---:|
| AX#1 No Verb Overlap | — | — | 1 | — | 1 |
| AX#2 Safe Defaults | — | 2 | 1 | — | 3 |
| AX#3 Structured Outputs | — | 2 | 3 | 2 | 7 |
| AX#4 Machine-Readable Errors | — | 5 | 8 | 2 | 15 |
| AX#5 Fast Fail Early | 1 | 1 | 3 | 1 | 6 |
| AX#6 Deterministic Outputs | — | — | 1 | 2 | 3 |
| AX#7 Explicit Over Implicit | — | 1 | 4 | 2 | 7 |
| AX#8 Composable Primitives | — | — | 1 | 1 | 2 |
| AX#9 Narrow Contracts | — | — | — | 1 | 1 |
| AGENTS.md (SRP/ISP/DI) | — | — | 3 | 1 | 4 |
| Architecture Gap | — | 1 | — | — | 1 |
| **Total (new)** | **1** | **12** | **25** | **12** | **50** |

---

## CRITICAL

### AX-01 — Dead code: duplicate unreachable guard in `task_dispatch.ts`

- **Status:** Resolved on 2026-04-02. Guard moved before `expireAwaitedInputIfNeeded`;
  throw fires for non-INPUT_REQUIRED tasks, return preserved for expired-input case.
- **Principle:** AX#5 Fast Fail Early
- **File:** `src/orchestration/broker/task_dispatch.ts:210-220`

---

## HIGH

### AX-02 — Tools: 5 cron tools have no `dry_run` guard

- **Status:** Resolved on 2026-04-02. `dry_run` added to create, delete, enable,
  disable tool definitions. Default `true`, returns structured preview.
- **Principle:** AX#2 Safe Defaults
- **File:** `src/agent/tools/cron.ts`

### AX-03 — Tools: `send_to_agent` has no `dry_run` guard

- **Status:** Resolved on 2026-04-02. `dry_run` added (default `true`), returns preview.
- **Principle:** AX#2 Safe Defaults
- **File:** `src/agent/tools/send_to_agent.ts`

### AX-04 — `tunnel_protocol.ts`: 8 raw `throw new Error` at the WebSocket boundary

- **Status:** Resolved on 2026-04-02. All throws converted to `OrchestrationError`
  with `TUNNEL_REGISTER_INVALID` / `TUNNEL_CONTROL_INVALID` codes + field context.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/orchestration/tunnel_protocol.ts:88-157`

### AX-05 — `federation_control_handlers.ts`: all validation throws are raw `Error`

- **Status:** Resolved on 2026-04-02. All throws converted to `FederationError`
  with `FEDERATION_PAYLOAD_INVALID` code + field/messageType context.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/orchestration/broker/federation_control_handlers.ts:15-129`

### AX-06 — `memory.ts`: all tool outputs are prose strings

- **Status:** Resolved on 2026-04-02. All 4 actions return structured JSON.
- **Principle:** AX#3 Structured Outputs
- **File:** `src/agent/tools/memory.ts`

### AX-07 — `web.ts`: fetch tool output mixes HTTP metadata into prose

- **Status:** Resolved on 2026-04-02. Returns `{ status, body, truncated }` JSON.
  Timeout detection via `DOMException.name` instead of string matching (AX-39 also fixed).
- **Principle:** AX#3 Structured Outputs
- **File:** `src/agent/tools/web.ts`

### AX-08 — `worker_protocol.ts`: `run_error` missing `context`/`recovery` fields

- **Status:** Resolved on 2026-04-02. Added `context?` and `recovery?` to `run_error`
  type. All 3 error paths in `worker_runtime_run.ts` now populate `recovery`.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/agent/worker_protocol.ts`, `src/agent/worker_runtime_run.ts`

### AX-09 — `peer_delivery.ts`: peer error responses are bare strings

- **Status:** Resolved on 2026-04-02. Added `errorCode?` to `peer_result` type.
  Set `WORKER_NOT_INITIALIZED` / `PEER_TASK_FAILED` on both error paths.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/agent/worker_runtime_peer_delivery.ts`

### AX-10 — `loop.ts`: `agentId` silently falls back to `sessionId`

- **Status:** Resolved on 2026-04-02. Added `log.warn` when fallback is used.
- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/agent/loop.ts`

### AX-11 — Missing `recovery` on 9+ monitoring/gateway HTTP error responses

- **Status:** Resolved on 2026-04-02. `recovery` added to all KV_UNAVAILABLE,
  AGENT_NOT_FOUND, MISSING_CONTEXT_ID, TRACE_NOT_FOUND responses in
  monitoring_routes, agent_routes, and broker http_routes.
- **Principle:** AX#4 Machine-Readable Errors

### AX-12 — `webhook.ts`: bare string error response

- **Status:** Resolved on 2026-04-02. Returns structured `WEBHOOK_PARSE_ERROR` with
  context/recovery. Also fixed 405 and 401 responses to be structured JSON.
- **Principle:** AX#3/AX#4 Structured Outputs + Machine-Readable Errors
- **File:** `src/messaging/channels/webhook.ts`

### AX-13 — Architecture gap: no `toErrorMessage()` / `wrapError()` in shared/errors.ts

- **Status:** Resolved on 2026-04-02. Added `toErrorMessage()`, `wrapError()`,
  `OrchestrationError`, and `FederationError` to `shared/errors.ts`.
- **Principle:** AX#4 (infrastructure gap)
- **File:** `src/shared/errors.ts`

---

## MEDIUM

### AX-14 — `A2A client`: error field mapping is inconsistent

- **Status:** Resolved on 2026-04-02. Added `mapRpcErrorCode()` that maps numeric
  RPC codes to typed `A2A_TASK_NOT_FOUND` etc. All 3 methods now use it consistently.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/messaging/a2a/client.ts`

### AX-15 — `A2A server`: no validation of `rpc.id` or message shape

- **Principle:** AX#5 Fast Fail Early
- **File:** `src/messaging/a2a/server.ts:78,83-85,111-113`
- **Impact:** Missing `rpc.id` is silently replaced with `""` (line 371). A
  message without `messageId`/`role`/`parts` passes the truthiness check and
  creates a malformed `Task.history`.
- **Fix:** Reject at boundary if `rpc.id` missing. Add structural check on
  `params.message.parts` before dispatch.

### AX-16 — `webhook.ts`: empty content dispatched silently

- **Status:** By design — empty content is used as an interrupt signal for running tasks.
- **Principle:** AX#5 Fast Fail Early
- **File:** `src/messaging/channels/webhook.ts:64-88`

### AX-17 — `session.ts`: magic default `channelType = "cli"`

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/messaging/session.ts:26-27`
- **Impact:** Any caller missing explicit `channelType` silently tags the session
  as `cli`. A session created from webhook/telegram context appears with wrong type.
- **Fix:** Remove default. Require `channelType` as mandatory.

### AX-18 — `loop.ts`: magic default model and temperature

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/agent/loop.ts:106-107`
- **Impact:** `model || "anthropic/claude-sonnet-4-6"` and `temperature ?? 0.7`
  silently override missing/empty config. A misconfigured registry uses a
  different model than intended.
- **Fix:** Require `model` to be non-empty. Move temperature default to a named
  constant documented in the config schema.

### AX-19 — `tool_dispatch.ts`: hidden mode switch on `isDeployEnvironment()`

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/orchestration/broker/tool_dispatch.ts:374-387`
- **Impact:** `resolveToolExecutionConfig` silently branches filesystem vs KV
  backend based on an ambient environment variable. Agent runtime has no way to
  know which backend is active.
- **Fix:** Make `workspaceBackend` an explicit config value.

### AX-20 — `gateway/websocket.ts`: missing token silently assigned random UUID

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/orchestration/gateway/websocket.ts:107`
- **Impact:** `const token = url.searchParams.get("token") || crypto.randomUUID()`
  silently assigns a random identity. Reconnection creates a new identity.
- **Fix:** Require token explicitly and return 400, or send
  `{ type: "assigned_token", token }` on socket open.

### AX-21 — `agent_store.ts`: raw `throw new Error` on KV failures

- **Status:** Resolved on 2026-04-02.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/orchestration/agent_store.ts`

### AX-22 — `relay.ts`: 3 raw `throw new Error`

- **Status:** Resolved on 2026-04-02. All 4 throws converted to `OrchestrationError`.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/orchestration/relay.ts`

### AX-23 — `ollama.ts` embedder: 6 raw `throw new Error`

- **Status:** Resolved on 2026-04-02. All 6 throws converted to `ProviderError`.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/agent/embedders/ollama.ts`

### AX-24 — `deploy_api.ts`: 6 raw `throw new Error` in CLI deploy paths

- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/cli/deploy_api.ts:55,162,184,194,219,256`
- **Impact:** HTTP error paths throw raw strings. Propagate to `publish.ts` where
  they are printed but never structured.
- **Fix:** Shared `new DenoClawError("DEPLOY_API_ERROR", { status, body, operation }, "...")`

### AX-25 — `A2A tasks.ts`: verb overlap (duplicate method names)

- **Status:** Resolved on 2026-04-02. Removed `cancelTask()` and `addMessage()`
  aliases. Updated `server.ts` call site to use `cancel()`.
- **Principle:** AX#1 No Verb Overlap
- **File:** `src/messaging/a2a/tasks.ts`

### AX-26 — `A2A server.ts`: `handleStream` is a 120-line monolith

- **Principle:** AX#8 Composable Primitives
- **File:** `src/messaging/a2a/server.ts:166-283`
- **Impact:** Fuses task creation, state machine transitions, SSE encoding,
  artifact enumeration, error recovery, and stream lifecycle. Duplicates
  create-or-continue logic from `handleSend`.
- **Fix:** Extract `runHandler(task, message)` shared by send and stream paths.

### AX-27 — `file.ts`: `WriteFileTool` validation bypassed by `as` cast

- **Status:** Resolved on 2026-04-02. `typeof` checks before assignment.
  KV write path also returns structured JSON output.
- **Principle:** AX#5 Fast Fail Early
- **File:** `src/agent/tools/file.ts`

### AX-28 — `gateway/agent_routes.ts:34`: error swallowed silently

- **Status:** Resolved on 2026-04-02. Returns `{ ok: true, warning: "AGENT_START_SKIPPED", context }`.
  AGENT_NOT_FOUND on GET also got a `recovery` field.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/orchestration/gateway/agent_routes.ts`

### AX-29 — `sandbox_manager.ts:168`: implicit `ownershipScope` default

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/orchestration/broker/sandbox_manager.ts:168`
- **Impact:** `context?.ownershipScope ?? "agent"` silently changes sandbox
  isolation semantics.
- **Fix:** Require `ownershipScope` explicitly.

### AX-30 — `bus.ts`: double-init risk (listenQueue registered twice)

- **Status:** Resolved on 2026-04-02. Added `listenerRegistered` guard.
- **Principle:** AGENTS.md Single Responsibility
- **File:** `src/messaging/bus.ts`

### AX-31 — `message_runtime.ts:105`: recovery is "Check broker logs"

- **Status:** Resolved on 2026-04-02. Recovery changed to actionable message.
- **Principle:** AX#4 Machine-Readable Errors
- **File:** `src/orchestration/broker/message_runtime.ts`

### AX-32 — `A2A server.ts`: `failTask` embeds error as prose TextPart

- **Principle:** AX#3 Structured Outputs
- **File:** `src/messaging/a2a/server.ts:353-358`
- **Impact:** Error surface is a human-readable string in `status.message.parts[0].text`.
  No machine-readable error code alongside.
- **Fix:** Accept `{ code, message, context? }` and embed into `TaskStatus.metadata`.

### AX-33 — `channels/discord.ts` + `telegram.ts`: `send()` swallows failures

- **Principle:** AX#3 Structured Outputs
- **File:** `src/messaging/channels/discord.ts:122-141`, `src/messaging/channels/telegram.ts:122-158`
- **Impact:** Both `send()` methods log errors but return `void`. Caller has no
  signal that delivery failed.
- **Fix:** Throw a `ChannelError` instead of silently returning.

---

## LOW

### AX-34 — Broker/gateway root paths return plain text

- **Status:** Resolved on 2026-04-02.
- **Principle:** AX#3 Structured Outputs
- **Files:** `src/orchestration/broker/http_routes.ts`, `src/orchestration/gateway/http_routes.ts`

### AX-35 — 404 fallthrough returns plain text

- **Status:** Resolved on 2026-04-02.
- **Principle:** AX#3 Structured Outputs
- **Files:** `src/orchestration/gateway/http_routes.ts`, `src/orchestration/broker/http_routes.ts`

### AX-36 — `federation_http_routes.ts`: inline `crypto.randomUUID()` for traceId

- **Principle:** AX#6 Deterministic Outputs
- **File:** `src/orchestration/broker/federation_http_routes.ts:40,106,159,186,334`
- **Impact:** `traceId` is caller-invisible. Retries get different traceIds.
- **Fix:** Accept optional `traceId` from request, fallback to UUID.

### AX-37 — `A2A server.ts`: `completeTask` uses `crypto.randomUUID()` for artifactId

- **Principle:** AX#6 Deterministic Outputs
- **File:** `src/messaging/a2a/server.ts:142,155,339-347`
- **Impact:** `task_mapping.ts` already has deterministic `${task.id}:result` pattern.
  Server bypasses it.
- **Fix:** Use `${task.id}:result` pattern from `task_mapping.ts`.

### AX-38 — `context.ts`: `new Date()` hardcoded in `buildContextMessages`

- **Status:** Resolved on 2026-04-02. Added `now` parameter to `buildContextMessages`.
- **Principle:** AX#6 Deterministic Outputs
- **File:** `src/agent/context.ts`

### AX-39 — `web.ts`: timeout detection via string matching

- **Status:** Resolved on 2026-04-02 (fixed alongside AX-07).
- **Principle:** AX#5 Fast Fail Early
- **File:** `src/agent/tools/web.ts`

### AX-40 — `A2A server.ts`: card served at two paths simultaneously

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/messaging/a2a/server.ts:51-53`
- **Fix:** Serve card at exactly one canonical path.

### AX-41 — `A2A server.ts`: silent fallback to `/a2a` on malformed card URL

- **Principle:** AX#7 Explicit Over Implicit
- **File:** `src/messaging/a2a/server.ts:45,65-72`
- **Fix:** Validate `card.url` in constructor. Throw `ConfigError` if invalid.

### AX-42 — `registry.ts`: `setBackend` takes 7 positional parameters

- **Principle:** AX#8 Composable Primitives
- **File:** `src/agent/tools/registry.ts:63-80`
- **Fix:** Replace with a single `SandboxBackendConfig` options object.

### AX-43 — `tool_executor.ts`: no input validation at subprocess boundary

- **Status:** Resolved on 2026-04-02. Added `tool` and `args` validation after parse.
- **Principle:** AX#9 Narrow Contracts
- **File:** `src/agent/tools/tool_executor.ts`

### AX-44 — `channels/base.ts`: `ChannelAdapter` forces inbound+outbound interface

- **Principle:** AGENTS.md Interface Segregation
- **File:** `src/messaging/channels/base.ts:16`
- **Impact:** Webhook implements `send()` as no-op. Console `send()` goes to stdout.
  Callers cannot rely on `send()` without knowing adapter type.
- **Fix:** Split into `InboundChannel` / `OutboundChannel` ports.

### AX-45 — `file.ts`: `WriteFileTool` success output is prose

- **Status:** Resolved on 2026-04-02 (fixed alongside AX-27).
- **Principle:** AX#3 Structured Outputs
- **File:** `src/agent/tools/file.ts`

---

## Already tracked (duplicates with existing issues)

| AX finding | Existing ID | Description |
|------------|-------------|-------------|
| A2A server no auth | SEC-01 | Zero auth enforcement on A2A server |
| `as BrokerEnvelope` cast without guard | SEC-01 note, TYPE family | Raw cast on unvalidated JSON |
| `as JsonRpcRequest` cast without guard | BUG-10 area | A2A client/server unsafe casts |
| `bus.ts` cast without guard | BUG-15/67 area | MessageBus flagged as broken |
| `A2A client` missing timeout | BUG-10 | getTask/cancelTask missing timeout |
| `federation/kv_adapter.ts` raw throws | 03-architecture | Federation adapter concerns |
| `sandbox_manager.ts` raw throws | 03-architecture area | Sandbox error handling |
| `setup/broker_deploy.ts` raw throws | 06-ux-cli area | CLI error handling |
| `memory_kvdex.ts` catch-and-swallow | BUG-54,72 | Silent error swallowing in memory |

---

## Resolution Progress

Resolved on 2026-04-02: **31 issues** (AX-01–14, 21–23, 25, 27, 28, 30, 31,
34, 35, 38, 39, 43, 45 + tests updated).

### Remaining — P2 (structural refactors / design decisions)

- **AX-15** — A2A server rpc.id + message shape validation
- **AX-16** — webhook empty content validation
- **AX-17/18/19** — Remove magic defaults (session, model, workspace backend)
- **AX-20** — Gateway websocket token assignment
- **AX-24** — deploy_api.ts raw throws (CLI-only paths)
- **AX-26** — Refactor A2A handleStream monolith
- **AX-29** — Sandbox ownershipScope default
- **AX-32** — A2A failTask prose error
- **AX-33** — Discord/Telegram send() swallows failures
- **AX-36/37** — Deterministic traceId/artifactId
- **AX-40/41** — A2A card path / URL validation
- **AX-42** — registry.ts positional params
- **AX-44** — ChannelAdapter interface segregation
