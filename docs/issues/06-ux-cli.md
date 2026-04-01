# UX & CLI Issues

Review date: 2026-04-01

---

## MEDIUM

### UX-01 — JSON errors on stdout mix with structured output
- **File:** `src/cli/output.ts:82-88`
- **Fix:** Write errors to stderr even in JSON mode

### UX-02 — `choose()` silently picks first option in non-interactive mode
- **File:** `src/cli/prompt.ts:58-59`
- **Fix:** Throw `CliError("NON_INTERACTIVE_UNSUPPORTED")`

### UX-03 — Bulk publish defaults to Y on Enter (destructive default)
- **File:** `src/cli/publish.ts:132`
- **Fix:** Default `confirm` to false

### UX-04 — No `requireInteractive` guard in `deployBroker`
- **File:** `src/cli/setup/broker_deploy.ts:19-33`
- **Fix:** Call `requireInteractive("denoclaw deploy")` at top

### UX-05 — `CreateAgentModal` shows raw API error JSON to users
- **Status:** Resolved in code on 2026-04-01.
- **File:** `web/islands/CreateAgentModal.tsx:67-69`
- **Fix:** Parse JSON, extract `error.message`

### UX-06 — No loading state while SSR data fetching
- **Files:** All route pages
- **Fix:** Add timeout to all route-level fetches (3-5s)

### UX-07 — Dashboard NavBar omits Cron and Tunnels pages
- **Status:** Resolved in code on 2026-04-01.
- **File:** `web/components/NavBar.tsx`

### UX-08 — A2A search filter loses status on submit and vice versa
- **Status:** Resolved in code on 2026-04-01.
- **File:** `web/routes/a2a/index.tsx:98-110`
- **Fix:** Make status tabs preserve `q` parameter

---

## LOW

### UX-09 — `which` not available on Windows
- **File:** `src/cli/setup/providers.ts:33`
- **Fix:** Use binary `--version` check instead

### UX-10 — No range validation for temperature/maxTokens
- **File:** `src/cli/setup/agent_defaults.ts:14-22`

### UX-11 — `ask()` read buffer fixed at 1024 bytes
- **File:** `src/cli/prompt.ts:35`

### UX-12 — `humanLog` and `humanPrint` are identical implementations
- **File:** `src/cli/output.ts:40-46`

### UX-13 — `ActivityFeed` SSE onerror doesn't explicitly reconnect
- **File:** `web/islands/ActivityFeed.tsx:139-141`

### UX-14 — Mobile dropdown has no close-on-click behavior
- **File:** `web/components/NavBar.tsx:43-79`

### UX-15 — `FlameChart` SVG labels clip outside bounding box
- **File:** `web/islands/FlameChart.tsx:178-187`

### UX-16 — `AlertStrip` uses array index as React key
- **File:** `web/components/AlertStrip.tsx:62`

### UX-17 — Misleading broker registration error message
- **File:** `src/cli/publish.ts:266-267`

### UX-18 — `NetworkGraph` destroys/recreates Cytoscape on every render
- **File:** `web/islands/NetworkGraph.tsx:197`
