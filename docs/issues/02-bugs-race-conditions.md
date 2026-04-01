# Bugs & Race Conditions

Review date: 2026-04-01

---

## CRITICAL

### BUG-01 — `a2a/mod.ts` interface exported without `type` keyword (compile error)
- **Status:** Resolved in code on 2026-04-01.
- **File:** `src/messaging/a2a/mod.ts:25`
- **Impact:** Breaks `deno check` with TS1205
- **Fix:** `export type { A2ARuntimePort, ... } from "./runtime_port.ts"`

### BUG-02 — `getKv()` async initialization race (KV handle leak)
- **File:** `src/orchestration/broker/server.ts:250-263`
- **Impact:** Two parallel callers both call `Deno.openKv()`, first handle leaks forever
- **Fix:** Store `kvOpenPromise` and reuse: `this.kvOpenPromise ??= Deno.openKv()`

---

## HIGH

### BUG-03 — `TaskStore.updateStatus` has no KV atomic check-and-set (lost-update race)
- **File:** `src/messaging/a2a/tasks.ts:68-80`
- **Impact:** Concurrent task updates can overwrite each other; COMPLETED task re-transitioned
- **Fix:** Use `kv.atomic().check(entry.versionstamp).set(...).commit()` with retry loop

### BUG-04 — `initialize()` called on every `processMessage()` — double-load on reuse
- **File:** `src/agent/loop.ts:202-210`
- **Impact:** `memory.load()` + `skills.loadSkills()` fire on every call; cache duplication
- **Fix:** Add `initialized` guard flag

### BUG-05 — `memory_kvdex.ts`: `seq` incremented before write succeeds
- **File:** `src/agent/memory_kvdex.ts:123-150`
- **Impact:** Write failure leaves seq gap; order corruption on reload
- **Fix:** Increment seq only after successful write

### BUG-06 — `listTopics()` loads full long-term facts without pagination
- **File:** `src/agent/memory_kvdex.ts:224`
- **Impact:** OOM for agents with many long-term facts
- **Fix:** Paginate `getMany()` or use secondary index

### BUG-07 — Deploy runtime: broker messages arrive before `runtime.start()` finishes
- **File:** `src/agent/deploy_runtime.ts:164-196`
- **Impact:** Early messages hit `AGENT_RUNTIME_NOT_READY`, silently lost
- **Fix:** Connect WebSocket transport only after `runtime.start()` resolves

### BUG-08 — `cron_manager.ts`: KV result object mutated directly
- **File:** `src/orchestration/broker/cron_manager.ts:106-107`
- **Impact:** Deploy KV may cache/share reference across calls
- **Fix:** Clone: `{ ...current.value, lastRun: new Date().toISOString() }`

### BUG-09 — `replyToolResult` and `recordToolCall` unawaited in sandbox success path
- **File:** `src/orchestration/broker/tool_dispatch.ts:245-251`
- **Impact:** Agent never receives tool result if reply routing fails
- **Fix:** Add `await` to both calls

### BUG-10 — `A2AClient.getTask`/`cancelTask` missing timeout and `res.ok` check
- **File:** `src/messaging/a2a/client.ts:186-200, 225-240`
- **Impact:** Hangs forever on slow remote; malformed JSON on HTTP errors
- **Fix:** Add `AbortSignal.timeout(30_000)` and `if (!res.ok)` guard

### BUG-11 — `deleteDeadLetter` calls `claimDeadLetter` instead of deleting
- **Status:** Resolved in code on 2026-04-01.
- **File:** `src/orchestration/federation/adapters/kv_adapter.ts:358-363`
- **Impact:** Dead letters accumulate permanently
- **Fix:** Implement proper delete path

### BUG-12 — Task status message double-added to history
- **Status:** Resolved in code on 2026-04-01.
- **File:** `src/messaging/a2a/tasks.ts:75-76`
- **Impact:** Completion message appears twice in task history
- **Fix:** Remove redundant `nextTask.history.push(message)` line

### BUG-13 — Ollama has `requiresKey: true` but is key-optional
- **Status:** Resolved in code on 2026-04-01.
- **File:** `src/llm/manager.ts:79`
- **Impact:** Ollama silently skipped when no API key set; `NO_PROVIDER` error
- **Fix:** Set `requiresKey: false` for ollama entry

### BUG-14 — WebSocket transport: concurrent sends during reconnect fail
- **File:** `src/orchestration/transport_websocket.ts:136-155`
- **Impact:** Burst of `TRANSPORT_NOT_STARTED` errors after reconnection
- **Fix:** After awaiting `connectPromise`, re-check `readyState` instead of returning

---

## MEDIUM

### BUG-15 — `MessageBus.init()` double-call registers two `listenQueue` handlers
- **File:** `src/messaging/bus.ts:31-50`
- **Impact:** Messages dispatched twice per publish
- **Fix:** Add `isListening` flag; return early if already listening

### BUG-16 — `monitoring.ts` `ensureAgentListed` has TOCTOU race
- **File:** `src/orchestration/monitoring.ts:83-95`
- **Impact:** Concurrent agent registrations lose entries (last writer wins)
- **Fix:** Use `kv.atomic().check(current).set(...)` with retry loop

### BUG-17 — Rate limiter double-counts on first-request race
- **File:** `src/orchestration/rate_limit.ts:33-52`
- **Impact:** Stale `null` entry returns `current = 1` even if 10 requests raced
- **Fix:** Fresh `kv.get()` after atomic sum

### BUG-18 — `cron_manager.ts` `reloadAll()` deletes cron jobs on any error (not just schedule)
- **File:** `src/orchestration/broker/cron_manager.ts:86-89`
- **Impact:** Transient error permanently destroys cron job
- **Fix:** Only delete on schedule-related errors

### BUG-19 — `MetricsCollector.recordAgentMessage` races on `peers` list
- **File:** `src/telemetry/metrics.ts:183-194`
- **Impact:** Concurrent calls with different agents lose entries
- **Fix:** Per-peer KV key instead of read-modify-write on array

### BUG-20 — Console/Webhook channels: `onMessage` called without `await`
- **File:** `src/messaging/channels/console.ts:58`, `webhook.ts:69`
- **Impact:** Handler errors silently dropped; webhook responds before processing
- **Fix:** `await this.onMessage?.(msg)` in both places

### BUG-21 — Discord channel: transient scope failure routes first message wrong
- **File:** `src/messaging/channels/discord.ts:215-234`
- **Fix:** Cache fallback result with TTL or queue message until resolution

### BUG-22 — Module-level Preact signals shared across SSR requests (state leak)
- **Files:** `web/islands/EventStream.tsx:6-7`, `web/islands/MetricsPanel.tsx:6`
- **Impact:** User A's data bleeds into User B's rendered HTML
- **Fix:** Move signals inside component or use `useSignal()`

### BUG-23 — `MetricsPanel` mutates signal during render (not in useEffect)
- **File:** `web/islands/MetricsPanel.tsx:20-22`
- **Fix:** Move to `useEffect(() => { ... }, [])`

### BUG-24 — `instances.ts` module-level cache never invalidated
- **File:** `web/lib/instances.ts:13`
- **Fix:** Remove cache or add TTL

### BUG-25 — NavBar active state never fires (leading `/` mismatch)
- **Status:** Resolved in code on 2026-04-01.
- **File:** `web/components/NavBar.tsx:25-26`
- **Impact:** No nav item ever highlighted as active
- **Fix:** `currentPath === \`/\${item.href}\``

### BUG-26 — `cost.tsx` N+1 sequential fetches per agent
- **File:** `web/routes/cost.tsx:69-78`
- **Fix:** `Promise.all` for parallel fetches

### BUG-27 — `overview.tsx` sequential metrics loop
- **File:** `web/routes/overview.tsx:105-117`
- **Fix:** `Promise.all` for the metrics loop

### BUG-28 — `formatRelative` returns "NaNs ago" on invalid ISO strings
- **Status:** Resolved in code on 2026-04-01.
- **File:** `web/lib/format.ts:21-30`
- **Fix:** Guard with `isNaN(d.getTime())`

### BUG-29 — Config saved even on total publish failure
- **File:** `src/cli/publish.ts:291-296`
- **Fix:** Only save if `published > 0`

### BUG-30 — `--no-prod` flag impossible (negatable not configured)
- **Status:** Resolved in code on 2026-04-01.
- **File:** `src/cli/args.ts:54`
- **Fix:** Add `negatable: ["prod"]`

### BUG-31 — `outputError; return` exits with code 0 in CI
- **File:** `src/cli/` (multiple)
- **Fix:** Throw `CliError` or call `Deno.exit(1)` after `outputError`

### BUG-32 — `enabled: false` not respected in primary provider loop
- **File:** `src/llm/manager.ts:113-120`
- **Fix:** Add `if (providerCfg?.enabled === false) continue`

### BUG-33 — `OpenAICompatProvider.complete`: no bounds check on `choices[0]`
- **File:** `src/llm/base.ts:132`
- **Fix:** Check empty choices before destructure

### BUG-34 — `wakeBroker()` adds 500ms latency on first connection attempt
- **File:** `src/orchestration/transport_websocket_runtime.ts:91-117`
- **Fix:** Call `wakeBroker()` only on retries (`attempt > 1`)

### BUG-35 — `lastActivity` in metrics always returns query time
- **File:** `src/telemetry/metrics_queries.ts:111`
- **Fix:** Record actual lastActivity timestamp in KV

### BUG-36 — `initTelemetry` never called (OTEL permanently no-op)
- **File:** `src/telemetry/mod.ts:39`
- **Fix:** Call in `startLocalGateway`, `startBrokerRuntime`, `startAgentRuntime`

---

## LOW

### BUG-37 — Max-iterations logged as trace status "completed"
- **File:** `src/agent/loop_process.ts:231-238`
### BUG-38 — `truncateContext` can split tool-call/result pairs
- **File:** `src/agent/context.ts:135-153`
### BUG-39 — Timer not cleared if `process.output()` throws
- **File:** `src/agent/tools/backends/local_process_runner.ts:37-55`
### BUG-40 — Worker `onReady` listener never removed on timeout/error
- **File:** `src/agent/worker_pool_lifecycle.ts:118-182`
### BUG-41 — Post-ready worker errors not cleaned up from pool
- **File:** `src/agent/worker_pool_lifecycle.ts:153-165`
### BUG-42 — Worker double shutdown from BroadcastChannel + direct message
- **File:** `src/agent/worker_entrypoint.ts:167-179`
### BUG-43 — `SessionManager.close()` closes injected KV it doesn't own
- **File:** `src/messaging/session.ts:98-103`
### BUG-44 — `bus.close()` clears handlers before KV closed (in-flight drop)
- **File:** `src/messaging/bus.ts:128-135`
### BUG-45 — KV leak on gateway shutdown (`kv` and `metrics` not closed)
- **File:** `src/runtime/start_local.ts:117-122`
### BUG-46 — `agentKv` not closed in interactive agent path
- **File:** `src/runtime/start_agent.ts:132-136`
### BUG-47 — `sync_agents.ts` hardcodes full permissions overwriting agent config
- **File:** `scripts/sync_agents.ts:74`
### BUG-48 — Dead code: duplicated unreachable condition in task_dispatch
- **File:** `src/orchestration/broker/task_dispatch.ts:210-221`
### BUG-49 — Concurrent sandbox init can provision two VMs
- **File:** `src/agent/tools/backends/cloud.ts:192-204`

---

## Pass 2 — Silent Failure Hunter (specialized agents)

### BUG-50 — CRITICAL: Cron fires silently when no callback registered
- **File:** `src/orchestration/broker/cron_manager.ts:99-116`
- **Impact:** Cron ticks, `lastRun` updated in KV (looks active), but NO task dispatched to agent
- **Detail:** When both `onFire` param and `this.onFireCallback` are undefined, handler is a silent no-op
- **Fix:** Log error when callback is missing; never update `lastRun` without dispatch

### BUG-51 — CRITICAL: `tool_dispatch.ts` catch block drops `sendStructuredError` silently
- **File:** `src/orchestration/broker/tool_dispatch.ts:249-256`
- **Impact:** Sandbox exec failure error reply never reaches agent (unawaited)
- **Fix:** `await` the sendStructuredError and wrap in try/catch

### BUG-52 — CRITICAL: Deploy runtime fire-and-forget loses task context in error log
- **File:** `src/agent/deploy_runtime.ts:156`
- **Impact:** Log message "task handling failed" has no agentId/taskId/messageType — impossible to correlate
- **Fix:** Enrich error log with msg.id, msg.type, agentId

### BUG-53 — HIGH: Cron `lastRun` update without atomic CAS — double-dispatch in multi-region
- **File:** `src/orchestration/broker/cron_manager.ts:104-107`
- **Impact:** Two broker instances fire same cron simultaneously, both dispatch tasks
- **Fix:** `kv.atomic().check(current).set(...).commit()`, invoke callback only if commit succeeds

### BUG-54 — HIGH: `memory_kvdex.ts` load failure silently resets to empty cache
- **File:** `src/agent/memory_kvdex.ts:114-120`
- **Impact:** Agent loses all conversation history on transient KV error; responds as if new user
- **Fix:** Return `{ loaded: boolean; error?: Error }` so caller can decide on recovery

### BUG-55 — HIGH: `consumeOnceTaskPrivilegeElevationGrants` CAS failure return value ignored
- **File:** `src/orchestration/broker/persistence.ts:165-202`, `tool_dispatch.ts:162-165`
- **Impact:** `once`-scoped privilege grant may not be consumed; agent reuses it on next tool call
- **Fix:** Check return value; log warning on false

### BUG-56 — HIGH: Malformed invite JSON silently produces unrestricted token
- **File:** `src/orchestration/broker/http_routes.ts:84`
- **Impact:** `req.json().catch(() => ({}))` treats parse error as `tunnelId: undefined` → global invite
- **Fix:** Return 400 on invalid JSON instead of fallback

### BUG-57 — HIGH: A2A stream error loses structured DenoClawError context
- **File:** `src/messaging/a2a/server.ts:241-262`
- **Impact:** `(e as Error).message` on non-Error throws → task failed with "undefined" text
- **Fix:** `e instanceof Error ? e.message : String(e)`, preserve DenoClawError context

### BUG-58 — HIGH: `void handleCronRequest` with no `.catch` in worker_pool
- **File:** `src/agent/worker_pool.ts:136`
- **Impact:** Uncaught cron dispatch errors silently dropped
- **Fix:** Add `.catch(err => log.error(...))`

### BUG-59 — HIGH: Optional chain `writeAgentLiveness?.()` leaves `.catch` on undefined
- **File:** `src/orchestration/broker/message_runtime.ts:87-93`
- **Impact:** If dependency absent, `.catch` on undefined → TypeError
- **Fix:** Use explicit `if (this.deps.writeAgentLiveness)` guard

### BUG-60 — CRITICAL: A2A server returns `rpcSuccess` when handler FAILS
- **File:** `src/messaging/a2a/server.ts:146-158`
- **Impact:** Error path wraps failed task in `rpcSuccess()` — caller sees no JSON-RPC error, task silently FAILED
- **Detail:** `A2AClient.send` checks only `response.error` which is absent; returns FAILED task as success
- **Fix:** Use `rpcError(rpc.id, A2A_ERRORS.INTERNAL_ERROR, msg)` instead of `rpcSuccess`

### BUG-61 — HIGH: A2A server `getEndpointPath` empty catch on URL parse
- **File:** `src/messaging/a2a/server.ts:64-69`
- **Impact:** Malformed `card.url` → silent fallback to wrong path → all RPC requests unhandled
- **Fix:** Log error in catch block

### BUG-62 — HIGH: A2A stream `controller.close()` not in `finally` block
- **File:** `src/messaging/a2a/server.ts:241-265`
- **Impact:** If `failTask` KV write throws, stream hangs forever, `activeStreams` memory leak
- **Fix:** Move cleanup to `finally` block

### BUG-63 — HIGH: SSE `JSON.parse` in A2A client has no error handling
- **File:** `src/messaging/a2a/client.ts:157`
- **Impact:** Single malformed SSE frame terminates entire async generator with opaque SyntaxError
- **Fix:** Wrap in try/catch, throw `DenoClawError("A2A_STREAM_PARSE_ERROR")`

### BUG-64 — HIGH: All `TaskStore` KV writes unchecked — state diverges on write failure
- **File:** `src/messaging/a2a/tasks.ts:41,54,78,95,121`
- **Impact:** `updateStatus` returns in-memory nextTask but KV keeps old state; restart replays stale state
- **Fix:** Check write result; throw on failure

### BUG-65 — HIGH: Webhook `send()` fetch has no try/catch — delivery silently dropped
- **Status:** Resolved in code on 2026-04-01.
- **File:** `src/messaging/channels/webhook.ts:88-101`
- **Impact:** Callback URL down → message lost, no log, caller sees success
- **Fix:** Remove outbound callback fetch path; ingress now returns `202 + taskId` and task state is queried via broker/gateway

### BUG-66 — MEDIUM: Discord/Telegram `send()` logs but never propagates errors
- **Files:** `src/messaging/channels/discord.ts:135-142`, `telegram.ts:140-158`
- **Impact:** Callers can never detect delivery failure; no retry possible
- **Fix:** Propagate error or return `{ ok: boolean }`

### BUG-67 — MEDIUM: `bus.ts` `safeCall` kills KV at-least-once delivery guarantee
- **File:** `src/messaging/bus.ts:109-121`
- **Impact:** Handler errors caught → KV queue acks unconditionally → no redelivery on failure
- **Fix:** Rethrow after logging if redelivery desired; update doc comment if not

### BUG-68 — MEDIUM: `session.ts` `lastActivity` KV write unchecked
- **File:** `src/messaging/session.ts:37-39`
- **Impact:** Session appears stale to `getActive`/`cleanup`; may be erroneously deleted
- **Fix:** Wrap in try/catch, log failure

### BUG-69 — CRITICAL: `loop_process.ts` endTrace `.catch(() => {})` — completely silent trace loss
- **File:** `src/agent/loop_process.ts:246-248`
- **Impact:** Trace data silently lost with zero log output; operator cannot diagnose tracing gaps
- **Fix:** Add `log.warn` inside catch

### BUG-70 — CRITICAL: `loop_process.ts` JSON.parse catch discards error context entirely
- **File:** `src/agent/loop_process.ts:144-155`
- **Impact:** No record of what malformed string looked like — impossible to diagnose LLM formatting regressions
- **Fix:** Bind error variable; log `tc.function.arguments.slice(0, 200)` and error message

### BUG-71 — HIGH: `worker_pool_observability.ts` three `catch(() => {})` on KV writes — dashboard state silently stale
- **File:** `src/agent/worker_pool_observability.ts:18-41`
- **Impact:** `writeActiveTask`, `clearActiveTask`, `writeAgentStatus` all silently fail → dashboard shows wrong state
- **Fix:** Replace empty catches with `log.warn`

### BUG-72 — HIGH: `memory_kvdex.ts` five write/read methods all swallow errors silently
- **File:** `src/agent/memory_kvdex.ts:149,193,215,229,241`
- **Impact:** `addMessage` failure → conversation in-memory only, lost on restart; `recall`/`listTopics` return empty silently
- **Fix:** At minimum propagate `addMessage` failures; add structured logs with content context

### BUG-73 — HIGH: `worker_entrypoint.ts` `peer_deliver` path has no task lifecycle wrapper
- **File:** `src/agent/worker_entrypoint.ts:285-308`
- **Impact:** If peer agent loop throws, source agent hangs 120s waiting for `AGENT_MSG_TIMEOUT`; real error never surfaced
- **Fix:** Wrap with `executeCanonicalWorkerTask` or explicit error handler returning structured response

### BUG-74 — HIGH: Broadcast route failures silently caught with no logging
- **File:** `src/orchestration/broker/task_dispatch.ts:424-442`
- **Impact:** Misconfigured broadcast route → per-agent task marked failed but zero log entry
- **Fix:** Add `log.error` in catch with agent ID and task ID

### BUG-75 — HIGH: Continuation loop in broadcast unguarded — leaves state inconsistent
- **File:** `src/orchestration/broker/task_dispatch.ts:547-567`
- **Impact:** `routeTaskContinuation` throws for one agent → loop aborts → remaining agents never notified → grants already persisted but unused
- **Fix:** Wrap in try-catch per iteration; collect errors and log

### BUG-76 — HIGH: Tunnel message catch collapses two failure modes (handle vs reply)
- **File:** `src/orchestration/broker/server.ts:433-437`
- **Impact:** Cannot distinguish "message handling failed" from "error reply failed"; missing agent ID in log
- **Fix:** Include `msg.from`, `msg.type` in error log

### BUG-77 — HIGH: `worker_pool_lifecycle.ts` terminate catch logs at debug level only
- **File:** `src/agent/worker_pool_lifecycle.ts:81-84, 98-101`
- **Impact:** At `LOG_LEVEL=info` (production), worker terminate failures completely invisible
- **Fix:** Promote to `log.warn`; include actual error

### BUG-78 — MEDIUM: `cloud.ts` `sandbox.kill().catch(() => {})` — orphaned VM with no log
- **File:** `src/agent/tools/backends/cloud.ts:236`
- **Fix:** Log kill error with context

### BUG-79 — MEDIUM: `runtime.ts` `stop()` loop aborts on first `mem.close()` error
- **File:** `src/agent/runtime.ts:354-365`
- **Impact:** First close error leaves remaining memories unclosed
- **Fix:** Wrap each close in individual try/catch

### BUG-80 — MEDIUM: `loop_process.ts` traceWriter calls unguarded inside task loop
- **File:** `src/agent/loop_process.ts:50-226`
- **Impact:** Transient KV trace write error kills entire user task
- **Fix:** Wrap traceWriter calls in best-effort pattern with `log.warn`

### BUG-81 — MEDIUM: `reply_dispatch.ts` `routeToTunnel` synchronous — no DOMException protection
- **File:** `src/orchestration/broker/reply_dispatch.ts:22-26`
- **Impact:** Closed WebSocket throws; reply silently dropped
- **Fix:** Wrap in try/catch or add protection inside `sendBrokerMessageOverTunnel`

### BUG-82 — MEDIUM: `persistence.ts` conflates missing task with empty metadata
- **File:** `src/orchestration/broker/persistence.ts:113-118`
- **Impact:** Stale taskId → `{}` → "no privilege elevation" instead of error
- **Fix:** Return `null` for missing task; handle explicitly in caller
