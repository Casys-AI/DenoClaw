# Documentation, Schema & Config Issues

Review date: 2026-04-01

---

## HIGH

### DOC-01 — `deno.lock` not committed (non-reproducible builds)
- **File:** `.gitignore:2`
- **Fix:** Remove `deno.lock` from `.gitignore` and commit it

### DOC-02 — Schema `SandboxPermission` enum missing `"schedule"`
- **Status:** Resolved in code on 2026-04-01.
- **File:** `schemas/agent.schema.json:71`
- **Impact:** `agent.json` with `"schedule"` in `allowedPermissions` fails validation
- **Fix:** Add `"schedule"` to enum

---

## MEDIUM

### DOC-03 — ADR-009 status stale ("In progress" but mostly implemented)
- **File:** `docs/adrs/adr-009-agent-memory-kvdex.md`
- **Fix:** Update status to `Accepted`; update implementation state

### DOC-04 — ADR-012 "Proposed" but largely implemented; `agent migrate` missing
- **File:** `docs/adrs/adr-012-agent-workspace-structure.md`
- **Fix:** Update status; document migrate command absence

### DOC-05 — Schema has `channels`/`channelRouting` not in TypeScript type
- **File:** `schemas/agent.schema.json`
- **Fix:** Align schema and `AgentEntry` type

### DOC-06 — `deno.json` `test:unit` task missing `--unstable-cron`
- **Fix:** Add flag or rely solely on `deno.json` `"unstable"` array

### DOC-07 — `sync_agents.ts` relative KV path `"data/shared.db"` is fragile
- **File:** `scripts/sync_agents.ts:24`
- **Fix:** Use `import.meta.url` relative path

---

## LOW

### DOC-08 — ADR-007 "Proposed" should be superseded by ADR-013
### DOC-09 — ADR-014 "Proposed" with zero implementation; should say "not yet implemented"
### DOC-10 — ADR-013 describes Prisma Postgres but no Prisma in codebase
### DOC-11 — `bob/agent.json` missing `$schema` field
### DOC-12 — `skills/` and `memories/` empty dirs not tracked in git
### DOC-13 — `.deployignore` excludes `data/` (intentional but undocumented)
### DOC-14 — `mod.ts:148` Skill type in wrong section
### DOC-15 — Schema `ExecPolicyAllowlist.allowedCommands` not required when security=allowlist
### DOC-16 — French comment in production code
- **File:** `src/orchestration/broker/reply_dispatch.ts:35`
