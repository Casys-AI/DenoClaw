# Architecture Issues

Review date: 2026-04-01

---

## HIGH

### ~~ARCH-01~~ — RESOLVED: `EventStream` mounted in `_app.tsx`
- **Status:** Resolved in code on 2026-04-02.

### ~~ARCH-02~~ — RESOLVED: `AgentStatusGrid` wired into `overview.tsx`
- **Status:** Resolved in code on 2026-04-02.

### ARCH-03 — Two KV namespaces for agent config (drift risk)
- **Files:** `src/orchestration/agent_store.ts` (`["config", "agents", agentId]`), broker registry (`["agents", agentId, "config"]`)
- **Impact:** Silent config drift between the two stores
- **Fix:** Unify in Phase 2 of workspace source-of-truth plan

---

## MEDIUM

### ARCH-04 — A2AServer always constructs its own TaskStore (no DI)
- **File:** `src/messaging/a2a/server.ts:33-36`
- **Fix:** Accept `TaskStore | Deno.Kv` as optional constructor param

### ARCH-05 — Skills inferred from sandbox permissions (wrong layer)
- **File:** `src/messaging/a2a/card.ts:42-77`
- **Impact:** Agent with `write` permission advertises `file_write` skill regardless of actual capability
- **Fix:** Skills from `AgentEntry.skills[]`, not inferred from permissions

### ARCH-06 — `ChannelManager.send` hardcodes `roomId: userId` (Telegram-specific)
- **File:** `src/messaging/channels/manager.ts:69-75`
- **Fix:** Require explicit `ChannelAddress` or document limitation

### ~~ARCH-07~~ — RESOLVED: `PageLayout` deleted (superseded by per-route headings)
- **Status:** Resolved in code on 2026-04-02.

### ARCH-08 — Inline fetch calls bypass `api-client.ts` abstractions
- **Files:** `web/routes/overview.tsx`, `a2a/index.tsx`, `agents/[id].tsx`, `cost.tsx`
- **Fix:** Add typed wrappers to `api-client.ts`

### ARCH-09 — `shared/types.ts` re-exports domain types (breaks shared kernel boundary)
- **File:** `src/shared/types.ts:8-22`
- **Impact:** Consumers of shared get transitive deps on agent/ and orchestration/
- **Fix:** Move re-exports out; consumers import from origin domain

### ~~ARCH-10~~ — PARTIALLY RESOLVED: 3 unused shims deleted (`trace_types.ts`, `trace_writer.ts`, `trace_reader.ts`)
- **Status:** Partially resolved on 2026-04-02. `traces.ts` shim kept (still actively imported by callers).

### ARCH-11 — `naming.ts` not in shared barrel; import boundary inconsistency
- **File:** `src/shared/mod.ts`
- **Fix:** Export from `mod.ts` or move to `src/cli/`

### ARCH-12 — Schema `additionalProperties: false` with mismatched TS type
- **Files:** `schemas/agent.schema.json`, `src/shared/types.ts`
- **Fix:** Align schema and TypeScript type for `channels`/`channelRouting`

---

## LOW

### ~~ARCH-13~~ — RESOLVED: `listByContext` exposed via `GET /tasks/context/:contextId`
- **Status:** Resolved in code on 2026-04-02.
### ~~ARCH-14~~ — RESOLVED: `publishGateway` deleted
- **Status:** Resolved in code on 2026-04-02.
### ~~ARCH-15~~ — RESOLVED: `subhosting_publish.ts` deleted (broken shim)
- **Status:** Resolved in code on 2026-04-02.
### ~~ARCH-16~~ — FALSE POSITIVE: `getDashboardAllowedUsers` — the `web/lib/` copy is unused but a live version exists in `src/orchestration/gateway/dashboard_auth.ts` and is actively called
- **File:** `web/lib/dashboard-auth.ts:124-131` (unused duplicate), `src/orchestration/gateway/dashboard_auth.ts:15` (live version)
### ARCH-17 — Duplicate `cancel`/`cancelTask` methods (verb overlap, AX-1)
- **File:** `src/messaging/a2a/tasks.ts:128-134`
### ARCH-18 — Duplicate `ensureChannelRoutingConfig` in two files
- **File:** `src/cli/setup/channels.ts:418`, `channel_routes.ts:413`
### ARCH-19 — Workspace agents invisible to channel route setup
- **File:** `src/cli/setup/channels.ts:368-369`
### ARCH-20 — `federation_catalog_sync` accepts empty agents array (silent wipe)
- **File:** `src/orchestration/broker/federation_control_handlers.ts:111-135`
### ARCH-21 — `federationEventSubscribers` map grows unboundedly
- **File:** `src/orchestration/federation/adapters/kv_adapter.ts:285-293`
### ARCH-22 — `mod.ts` public API surface missing ~17 exports
- **File:** `mod.ts`

---

## Pass 2 — Code Reviewer (specialized agents)

### ARCH-23 — Double KV read per tool request + import boundary violation
- **Files:** `src/orchestration/broker/tool_dispatch.ts:369`, `agent_registry.ts:13-25`, `persistence.ts:209`
- **Impact:** `resolveAgentConfigEntry` instantiates `new AgentStore(kv)` on every call; `handleToolRequest` calls it twice per request (once at top, once in `checkToolPermissions`)
- **Fix:** Thread loaded `agentConfig` into `checkToolPermissions` as param; inject `getAgentConfigEntry` via deps

### ARCH-24 — Raw `Error` throws at domain boundaries (not machine-readable)
- **Files:** `src/orchestration/types.ts:84,93`, `tunnel_protocol.ts:88-154`, `agent_store.ts:77,92`
- **Impact:** `extractBrokerSubmitTaskMessage`, `assertTunnelRegisterMessage`, `AgentStore.set/delete` throw raw strings — breaks structured error handling, loses code/context/recovery
- **Fix:** Replace with `DenoClawError` throughout

### ARCH-25 — `BrokerServer` constructor is a 127-line God wiring diagram
- **File:** `src/orchestration/broker/server.ts:100-226`
- **Impact:** Blends infrastructure provisioning (KV, sandbox), auth lifecycle, and wiring of 9 sub-runtimes; implicit init order dependencies
- **Fix:** Extract `BrokerDIContainer` factory; BrokerServer receives pre-assembled collaborators

### ARCH-26 — `continueAgentTask`/`continueChannelTask` duplicated 60-line resume logic
- **File:** `src/orchestration/broker/task_dispatch.ts:193-316`
- **Impact:** Bug fixes must be applied in two places (already missed in dead-code guard)
- **Fix:** Extract `resumeDirectTask(from, targetAgentId, existing, metadata, payload, message)`
