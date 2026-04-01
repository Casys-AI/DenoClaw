# Type Design Issues

Review date: 2026-04-01 — Pass 2 (specialized type-design-analyzer agents)

---

## Priority 1 — Trust Boundary Validation

### TYPE-01 — `as BrokerMessage` casts at 4 WebSocket trust boundaries with no structural validation
- **Files:** `broker/server.ts:426`, `transport_websocket.ts:176`, `relay.ts:179`, `agent_socket_upgrade.ts:95`
- **Impact:** Malformed/adversarial messages enter system typed as BrokerMessage; downstream `.payload` access throws uncontrolled TypeError
- **Fix:** Create `parseBrokerMessage(raw: unknown): BrokerMessage` (~30 lines) validating `id`, `type` (member of BrokerMessageType), `from`, `to`, `payload` (object), `timestamp` (string)

### TYPE-02 — `federation_control_handlers.ts:23` casts payload as `Record<string, unknown>` instead of receiving typed envelope
- **Impact:** Handler should receive `BrokerFederationLinkOpenMessage` directly, not `BrokerMessage` with downcast
- **Fix:** Type `FederationControlHandlerMap` handlers with specific message types

---

## Priority 2 — Invariant Expression Gaps

### TYPE-03 — `JsonRpcResponse` allows `result` AND `error` simultaneously (JSON-RPC 2.0 violation)
- **File:** `src/messaging/a2a/types.ts`
- **Fix:** Discriminated union: `{ result: unknown; error?: never } | { result?: never; error: JsonRpcError }`

### TYPE-04 — `acceptFrom?: string[]` hides `"*"` wildcard as magic value
- **File:** `src/shared/types.ts`
- **Impact:** Impossible to distinguish "no restrictions" from "empty list"
- **Fix:** `acceptFrom?: string[] | "*"`

### TYPE-05 — `PrivilegeElevationGrantSignature` is order-sensitive (grants array not sorted)
- **Files:** `src/shared/privilege_elevation.ts:76`, `src/shared/runtime_capabilities.ts:253`
- **Impact:** Same grants in different order → different signatures → failed deduplication → user re-prompted
- **Fix:** Sort `grant.grants` by `permission` before `JSON.stringify`

### TYPE-06 — `TERMINAL_STATES` is mutable `TaskState[]` instead of `as const`
- **File:** `src/messaging/a2a/types.ts`
- **Fix:** `as const satisfies readonly TaskState[]`

### TYPE-07 — `Task.history` and `Task.artifacts` are mutable arrays
- **File:** `src/messaging/a2a/types.ts`
- **Impact:** Any consumer can `task.history.push()` bypassing state machine
- **Fix:** `readonly A2AMessage[]` and `readonly Artifact[]`

### TYPE-08 — `FederationSessionToken` missing `expiresAt` field
- **File:** `src/orchestration/federation/types.ts`
- **Impact:** Active session tokens cannot be validated as expired without external state
- **Fix:** Add `expiresAt: string`

### TYPE-09 — `FederationLink.lastHeartbeatAt` optional on `"active"` state
- **File:** `src/orchestration/federation/types.ts`
- **Impact:** Active link may have no heartbeat recorded
- **Fix:** Split into state-specific types or validate before transition to active

---

## Priority 3 — Structural Duplication & Boundary Issues

### TYPE-10 — `AgentConfig` and `AgentEntry` near-duplicate types
- **Files:** `src/agent/types.ts`, `src/shared/types.ts`
- **Impact:** Both carry `model`, `temperature`, `maxTokens`, `systemPrompt` — changes to one may not propagate
- **Fix:** Derive `AgentConfig` from `AgentEntry`: `Required<Pick<AgentEntry, "model" | ...>>`

### TYPE-11 — `shared/types.ts` re-exports agent-domain types (boundary violation)
- **File:** `src/shared/types.ts:8-22`
- **Impact:** `CommandMode`, `ExecPolicy`, `ShellConfig`, `ToolExecutorConfig` from `agent/sandbox_types.ts` pulled into shared kernel
- **Fix:** Promote truly shared types natively; others import from agent domain directly

### TYPE-12 — `LLMRequest.messages[].role: string` widened from `MessageRole` union
- **File:** `src/orchestration/types.ts`
- **Impact:** Type safety lost on LLM proxy path
- **Fix:** Align with `MessageRole` or document intentional widening

### TYPE-13 — `LLMRequest.tools?: unknown[]` and `tool_calls?: unknown[]` lose all structure
- **File:** `src/orchestration/types.ts`
- **Fix:** At minimum `ToolDefinition[]` and `ToolCall[]`

### TYPE-14 — `RemoteAgentCatalogEntry.card: Record<string, unknown>` loses AgentCard structure
- **File:** `src/orchestration/federation/types.ts`
- **Fix:** Document reference to `AgentCard` type

---

## Priority 4 — Minor / Cosmetic

### TYPE-15 — `cloud.ts:56` `private sandbox: any` — only production `any` in source
- **Fix:** Define local `DenoSandboxInstance` interface for used methods

### TYPE-16 — `timestamp: string` fields everywhere with no opaque type
- **Fix:** `type IsoTimestamp = string` alias across all timestamp fields

### TYPE-17 — `FilePart.data: string` should communicate base64 encoding constraint
- **Fix:** `type Base64String = string` alias

### TYPE-18 — `MemoryPort.LongTermFact.confidence?: number` has no range constraint
- **Fix:** Document `[0, 1]` range

### TYPE-19 — `BrokerCronJob.schedule: string` no opaque type for cron expression
- **Fix:** `type CronSchedule = string & { __brand: "CronSchedule" }` + validated constructor

### TYPE-20 — `Message` should be discriminated union on `role`
- **File:** `src/shared/types.ts`
- **Impact:** `"tool"` message without `tool_call_id` compiles; `"system"` with `tool_calls` compiles
- **Fix:** Union: `{ role: "system"; content } | { role: "user"; content; name? } | { role: "assistant"; content; tool_calls? } | { role: "tool"; content; tool_call_id: string }`

### TYPE-21 — `ToolResult` should be discriminated union on `success`
- **File:** `src/shared/types.ts`
- **Impact:** `{ success: true, error: {...} }` is representable; contradictory state
- **Fix:** `{ success: true; output } | { success: false; output; error: StructuredError }`

### TYPE-22 — `StructuredError.code` is untyped string — no exhaustive error handling
- **File:** `src/shared/types.ts`
- **Impact:** Typo `"SANBOX_EXEC_FAILED"` never caught; no IDE completion
- **Fix:** `type StructuredErrorCode = "SANDBOX_EXEC_FAILED" | ... | (string & {})` (open extension)

### TYPE-23 — `task_result` appears in both request AND response unions (duplex breach)
- **File:** `src/orchestration/types.ts:224-235`
- **Impact:** `isBrokerRequestMessage(taskResultMsg)` returns true for semantic response
- **Fix:** Split into `BrokerTaskResultReportMessage` + `BrokerTaskResultReplyMessage`

### TYPE-24 — `FederatedSubmissionRecord` should be discriminated union on status
- **File:** `src/orchestration/federation/types.ts`
- **Impact:** `completed` record without `resultRef` representable; `dead_letter` without `lastErrorCode`
- **Fix:** Three-member union: `in_flight | completed (resultRef required) | dead_letter (lastErrorCode required)`

### TYPE-25 — `SignedCatalogEnvelope` needs `Verified<T>` phantom type
- **File:** `src/orchestration/federation/types.ts`
- **Impact:** No type-level distinction between verified and unverified catalogs
- **Fix:** `type VerifiedCatalogEnvelope = SignedCatalogEnvelope & { __verified: true }`; consumers require verified type

### TYPE-26 — `AgentStatusEntry` / `AgentStatusValue` duplicate status enum independently
- **File:** `src/orchestration/monitoring_types.ts`
- **Impact:** Fourth status added to one but not the other = silent divergence
- **Fix:** Extract shared `type AgentLifecycleStatus = "running" | "alive" | "stopped"`

### TYPE-27 — `SandboxConfig` cross-field dependencies invisible in type
- **File:** `src/shared/types.ts`
- **Impact:** `networkAllow` without `"net"` permission compiles; `execPolicy` without `"run"` compiles
- **Fix:** Factory `createSandboxConfig()` that silences contradictory fields

### TYPE-28 — No branded/opaque ID types anywhere (highest-risk cross-cutting omission)
- **Impact:** `taskId`, `agentId`, `brokerId`, `linkId`, `contextId`, `tunnelId`, `traceId` all raw `string` — no compile-time barrier against swapping
- **Fix:** `type AgentId = string & { __brand: "AgentId" }` etc. — zero runtime cost

---

## Type Family Ratings Summary

| Type Family | Encapsulation | Invariant Expression | Usefulness | Enforcement |
|-------------|:---:|:---:|:---:|:---:|
| Shared Kernel (`shared/types.ts`) | 3/5 | 3/5 | 4/5 | 2/5 |
| Orchestration Messages (`types.ts`) | 4/5 | 4/5 | 5/5 | 3/5 |
| A2A Protocol (`a2a/types.ts`) | 3/5 | 4/5 | 4/5 | 2/5 |
| Auth (`auth_types.ts`) | 3/5 | 5/5 | 4/5 | 3/5 |
| Privilege Elevation | 4/5 | 4/5 | 5/5 | 3/5 |
| Federation | 3/5 | 4/5 | 4/5 | 2/5 |
| MemoryPort | 4/5 | — | — | — |
| BrokerCronJob | 2/5 | — | — | — |
| AgentConfig/AgentEntry | 2/5 | — | — | — |

**Best designed:** `AuthResult` (discriminated union on `ok`), `BrokerEnvelope` (generic discriminant), `PrivilegeElevationGrantResource` (per-permission union)

**Most needs work:** Trust boundary casts (`as BrokerMessage`), `shared/types.ts` boundary violations, `AgentConfig`/`AgentEntry` duplication
