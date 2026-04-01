# Test Gaps

Review date: 2026-04-01

---

## HIGH

### TEST-01 — A2AServer + A2AClient: zero test files
- **Files:** `src/messaging/a2a/server.ts` (383 lines), `client.ts` (242 lines)
- **Missing:** handleSend, handleStream, handleGetTask, handleCancel, SSE events, auth bypass, error responses

### TEST-02 — WebhookChannel: no test file
- **File:** `src/messaging/channels/webhook.ts`
- **Missing:** Secret validation, SSRF callbackUrl, empty content

### TEST-03 — `deploy_runtime.ts:startDeployedAgentRuntime` no integration test
- **Missing:** Race condition (BUG-07), auth path (SEC-13), runtime init flow

### TEST-04 — `file_workspace.ts:resolveWorkspaceAccess` no sibling-agent traversal test
- **Missing:** Path traversal bypass case (SEC-06)

### TEST-05 — `broker_deploy.ts` zero test coverage
- **Missing:** KV provisioning, env var upsert logic, config save behavior

### TEST-06 — `publishAgents` no integration-level test
- **File:** `src/cli/publish.ts`
- **Missing:** Broker URL missing, partial failure, config save conditions

---

## MEDIUM

### TEST-07 — TaskStore: no KV race condition tests
- **File:** `src/messaging/a2a/tasks.ts`
- **Missing:** Concurrent atomic operation tests

### TEST-08 — `published_workspace.ts`: no test for `force` mode overwrite
- **Missing:** Force mode update path, preserve vs force conflict

### TEST-09 — `context.ts:truncateContext`: no test for split tool-call groups
- **Missing:** Tool-call group atomicity in truncation

### TEST-10 — E2E tests globally disable sanitizeResources/sanitizeOps
- **File:** `tests/e2e_test.ts:24`
- **Impact:** Masks resource leaks

### TEST-11 — `pool.start()` outside try/finally in tests 9, 10
- **File:** `tests/e2e_test.ts:793-840`
- **Impact:** Worker subprocess orphaned on start failure

### TEST-12 — No broker-level integration tests in `tests/`
- **Missing:** Full broker + agent + publish cycle end-to-end

---

## LOW

### TEST-13 — `entry_test.ts`: DENO_DEPLOYMENT_ID broker path untested
### TEST-14 — `console.ts` missing-await not tested
### TEST-15 — `session.ts` shared-KV lifetime in close() not tested
### TEST-16 — `worker_pool_peer_router` shutdown pending rejects untested
### TEST-17 — Cron test reuses same session ID across 3 calls
- **File:** `tests/e2e_test.ts:709-770`
### TEST-18 — Tests 9+10 use default 120s timeout instead of TEST_TIMEOUT_MS
- **File:** `tests/e2e_test.ts:795,860`
### TEST-19 — Test 7 uses hardcoded `/tmp/` path
- **File:** `tests/e2e_test.ts:587`
