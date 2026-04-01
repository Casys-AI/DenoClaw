# Security Issues

Review date: 2026-04-01

> **Note:** Some issues below are documented known limitations or deferred by design.
> These are annotated with `[DEFERRED]` or `[DOCUMENTED]`. The rest are genuine
> undocumented gaps.

---

## CRITICAL

### SEC-01 — A2A Server: zero authentication enforcement
- **File:** `src/messaging/a2a/server.ts:72-104`
- **Impact:** Any external caller can send tasks, get history, or cancel tasks without credentials
- **Detail:** `card.ts` advertises `authentication: { schemes: ["Bearer"] }` but `A2AServer.handleRpc` never checks `Authorization` header
- **Fix:** Accept `verifyToken` callback in constructor; extract and verify Bearer token before dispatching

### SEC-02 — Webhook channel: SSRF via caller-controlled `callbackUrl`
- **File:** `src/messaging/channels/webhook.ts:89-99`
- **Impact:** Attacker can redirect broker's outbound `fetch` to cloud metadata (169.254.169.254), internal services
- **Detail:** `callbackUrl` comes from POST body, used blindly in outbound fetch
- **Fix:** Validate against allowlist of permitted schemes/hosts; reject non-https

### ~~SEC-03~~ — ALREADY TRACKED: `notes/2026-03-30-denoclaw-api-token-followup.md`
- Token lifecycle deferred on purpose. Not a new finding.

### SEC-04 — OIDC audience validation skipped when env vars absent
- **File:** `src/orchestration/auth.ts:82-109`
- **Impact:** Any Deno OIDC token accepted regardless of target application
- **Detail:** `expectedAudience` stays `undefined` → `jose.jwtVerify` skips audience check
- **Fix:** Require audience on Deploy; throw at startup if missing

### SEC-05 — Dashboard SSRF via unvalidated `brokerUrl` cookie
- **File:** `web/lib/dashboard-auth.ts:150-152`, `web/routes/api/agents.ts:33`
- **Impact:** Authenticated dashboard user redirects server-side fetch to internal endpoints
- **Detail:** Token auth mode reads `brokerUrl` from user cookie, no host validation
- **Fix:** Allowlist of known broker hostnames; reject RFC-1918/loopback targets

---

## HIGH

### SEC-06 — Path traversal into sibling agent workspace
- **File:** `src/agent/tools/file_workspace.ts:21-24`
- **Impact:** Agent can read/write files in another agent's workspace
- **Detail:** `startsWith(ctx.workspaceDir)` without trailing separator: `/data/agents/foo` matches `/data/agents/foobar/`
- **Fix:** `startsWith(ctx.workspaceDir + "/")` or normalize with separator

### SEC-07 — Agent can register arbitrary agentId, hijacking messages
- **File:** `src/orchestration/broker/agent_socket_upgrade.ts:71-76`
- **Impact:** Authenticated tunnel registers any agentId, intercepts messages for that agent
- **Fix:** Assert `raw.agentId === authResult.identity` after registration

### SEC-08 — `cancelTask` / `getTask` have zero access control
- **File:** `src/orchestration/broker/task_dispatch.ts:318-320`
- **Impact:** Any authenticated agent can cancel or read any task by knowing its ID
- **Fix:** Assert `brokerMetadata.targetAgent === fromAgentId` before operating

### ~~SEC-09~~ — ALREADY TRACKED: `notes/2026-03-30-agent-ws-auth-followup.md`
- Static token in WS URL is a known pragmatic choice with documented follow-up plan. Not a new finding.

### SEC-10 — Full process environment leaked to deploy subprocess
- **File:** `src/cli/publish.ts:137-139`, `src/cli/setup/broker_deploy.ts:63`
- **Impact:** All parent env secrets (ANTHROPIC_API_KEY, etc.) passed to child process
- **Fix:** Allowlist only PATH, HOME, DENO_DEPLOY_TOKEN

### SEC-11 — API token printed to stdout (CI log exposure)
- **File:** `src/cli/setup/broker_deploy.ts:314`
- **Fix:** Print to stderr or behind TTY guard

### SEC-12 — Org-level Deploy token repurposed as sandbox token
- **File:** `src/cli/setup/broker_deploy.ts:287`
- **Impact:** Full org access token stored as sandbox credential
- **Fix:** Provision purpose-specific sandbox token

### ~~SEC-13~~ — ALREADY TRACKED: same as SEC-03, covered by `notes/2026-03-30-denoclaw-api-token-followup.md`
- Deploy runtime open without token is part of the same deferred token lifecycle. Not a new finding.

### SEC-14 — `deniedCommands` check matches substrings, not binaries `[DOCUMENTED]`
- **File:** `src/agent/tools/shell.ts:127-130`
- **Impact:** `"rm"` in denylist also blocks `"npm"`, `"chmod"`, etc.
- **Context:** ADR-010 + inline comment — "Keyword blocklist, intentionally matches anywhere in command string." Design choice, not accidental.
- **Fix:** Exact binary match first, substr as fallback (design improvement, not bug fix)

### SEC-15 — Sandbox field typed as `any` (no type safety on VM API)
- **File:** `src/agent/tools/backends/cloud.ts:55-56`
- **Fix:** Define `SandboxInstance` interface

### SEC-16 — No CSRF protection on state-mutating POST endpoints
- **File:** `web/routes/tunnels.tsx:100`, `web/routes/login.tsx:58`
- **Fix:** Double-submit CSRF token for HTML forms; verify Origin/Referer on API

### SEC-17 — Islands call broker directly without auth token
- **Files:** `web/islands/EventStream.tsx:54-58`, `web/islands/MetricsPanel.tsx:27`
- **Fix:** Route through dashboard `/api/` proxy with server-side token

### SEC-18 — Webhook secret comparison is not timing-safe
- **File:** `src/messaging/channels/webhook.ts:40-45`
- **Fix:** Use `timingSafeEqual` from Web Crypto API

### SEC-19 — Tunnel catalog sync bypasses ECDSA signature verification
- **File:** `src/orchestration/broker/tunnel_upgrade.ts:138-146`
- **Fix:** Use `syncSignedCatalog` path for tunnels

### SEC-20 — No auth check on Gateway WebSocket upgrade
- **File:** `src/orchestration/gateway/websocket.ts:107`
- **Impact:** User-controlled `token` param used as userId
- **Fix:** Call `checkAuth` before `upgradeWebSocket`

### SEC-21 — GitHub OAuth: any GitHub user can access dashboard when no allowlist
- **File:** `src/orchestration/gateway/dashboard.ts:12`
- **Fix:** Default `allowedUsers` to `[]` (deny all) instead of `undefined` (allow all)

---

## MEDIUM

### SEC-22 — Personal DENO_DEPLOY_TOKEN used as sandbox API fallback
- **File:** `src/shared/deploy_credentials.ts:6-11`
- **Fix:** Remove from `getSandboxAccessToken` fallback chain

### SEC-23 — Token stored in 30-day cookie with no rotation
- **File:** `web/lib/dashboard-auth.ts:218-224`
- **Fix:** Shorten max-age, add `__Host-` prefix

### SEC-24 — `getSafeDashboardRedirectTarget` allows open redirect
- **File:** `web/lib/dashboard-auth.ts:183-188`
- **Fix:** Validate `next` matches known dashboard path prefix

### SEC-25 — No security response headers (CSP, X-Frame-Options)
- **File:** `web/main.ts`
- **Fix:** Add middleware with security headers

### SEC-26 — A2A server leaks internal error messages to callers
- **File:** `src/messaging/a2a/server.ts:150-157`
- **Fix:** Sanitize error messages; return only `error.recovery`

### SEC-27 — `rpc.id` not validated per JSON-RPC 2.0 spec
- **File:** `src/messaging/a2a/server.ts:75-82`
- **Fix:** Validate id is string|number|null; handle notifications

### SEC-28 — Peer access control skipped when registry is empty `[DOCUMENTED]`
- **File:** `src/agent/worker_pool_peer_router.ts:52-75`
- **Context:** ADR-008 — local mode uses no auth; empty registry = dev/open mode by design
- **Fix:** Add `enforceACL` flag; default true when any entry has peers/acceptFrom
