# ADR-018: KV-Backed Workspace for Deploy

**Status:** Proposed
**Date:** 2026-04-01
**Related:** ADR-009 (memory dual model), ADR-012 (workspace structure)

## Context

ADR-009 established the dual model: filesystem locally, KV on Deploy.
ADR-012 defined the local authoring workspace as:

- `agent.json`
- `soul.md`
- `skills/`
- `memories/`

Since then, the deploy path has clarified that these files do not all belong to
the same ownership domain.

Validated current behavior as of 2026-04-01:

- deployed runtimes load `soul.md` from agent-private KV when present
- deployed runtimes load `skills/*` from agent-private KV
- deployed runtimes list workspace `memories/*` from agent-private KV
- broker-owned `read_file` / `write_file` routes workspace paths to KV in
  Deploy mode
- `denoclaw publish` snapshots `soul.md`, `skills/*`, and `memories/*` with
  explicit sync modes: default `preserve`, optional `--force`
- `agent.json` is already registered back to the broker and persisted there for
  operational use
- deploy runtime still keeps a published config fallback during boot, but
  workspace content now has its own KV path

So the remaining issue is not "put the whole workspace in KV." The real split
is:

- broker-owned control-plane config
- agent-owned workspace content

This ADR covers the agent-owned workspace content only.

## Decision

### 1. Scope of the agent-private workspace KV

The deploy workspace KV contains agent-owned content:

```
["workspace", agentId, "soul.md"]              → string
["workspace", agentId, "skills", ...path]      → string
["workspace", agentId, "memories", ...path]    → string
```

This scope intentionally excludes `agent.json`.

### 2. `agent.json` is broker-owned deploy config

`agent.json` remains the local authoring surface in `data/agents/<id>/`, but in
Deploy its canonical operational copy belongs to the broker control plane.

Validated current behavior:

- publish already registers agent config with the broker
- broker already persists that config in KV
- broker already uses that config for live decisions such as tool permission
  enforcement

Accepted direction:

- `agent.json` must not be modeled as part of the agent's private workspace KV
- deploy config should converge on one broker-side KV store
- publish remains the explicit boundary that pushes local `agent.json` into the
  broker-owned deploy registry

### 3. Transparent file tool routing

`read_file` and `write_file` detect workspace-relative paths and route to the
correct backend:

| Path pattern | Local | Deploy |
|---|---|---|
| `memories/*` | filesystem | KV `["workspace", agentId, "memories", ...]` |
| `skills/*` | filesystem | KV `["workspace", agentId, "skills", ...]` |
| `soul.md` | filesystem | KV `["workspace", agentId, "soul.md"]` |
| Other paths | filesystem | filesystem (if available) or error |

Current implementation status:

- `soul.md`, `skills/*`, and `memories/*` routing is in place

### 4. Publish/sync step

`denoclaw publish` serializes local workspace content into the deployed
agent's private KV:

```
For each agent workspace:
  1. Read soul.md (if present) → kv.set(["workspace", agentId, "soul.md"], content)
  2. For each skills/*.md      → kv.set(["workspace", agentId, "skills", ...], content)
  3. For each memories/*.md    → kv.set(["workspace", agentId, "memories", ...], content)
```

Separately, publish registers canonical agent config with the broker from
`agent.json`.

Current implementation status:

- `soul.md`, `skills/*`, and `memories/*` are already synced
- agent config registration with the broker already exists

This sync remains one-way (local → Deploy) for now:

- default `preserve` only creates missing tracked files
- `--force` overwrites conflicting tracked files for that publish revision
- extra remote files are not deleted

Bidirectional sync and reconcile/status flows are deferred.

### 5. Runtime loading

Deploy runtime should load agent-owned workspace content from the agent-private
KV, while treating broker-owned config as a separate concern.

Validated current behavior:

- soul loads from workspace KV when present
- skills already load through `KvSkillsLoader`
- memory file discovery already reads from workspace KV
- deploy config still also exists as a published entrypoint copy

Accepted direction:

- keep `soul.md`, `skills/*`, and `memories/*` on the workspace KV path
- keep broker-owned config bootstrap outside the scope of this ADR

### 6. Skills lifecycle (future direction — out of scope)

Skills may come from:

- local files (current)
- remote registry (future: ClawHub-like for DenoClaw)
- agent-installed at runtime (future: agent discovers and installs skills)

This ADR covers only the local → KV sync for agent-owned workspace content. A
future ADR should address:

- remote skill installation and versioning
- bidirectional sync
- skill dependency resolution
- skill hot-reload on deployed agents

## Implementation scope

| Component | File(s) | Change |
|---|---|---|
| Soul/workspace content loader | `src/agent/deploy_runtime.ts`, `src/agent/runtime.ts` | Load `soul.md` from workspace KV without treating `agent.json` as workspace KV |
| KvSkillsLoader | `src/agent/skills.ts` | Existing KV loader, already in place |
| Memory file listing | `src/agent/loop_workspace.ts` | Existing KV-backed file discovery, already in place |
| File tool routing | `src/agent/tools/file.ts`, `file_workspace.ts` | Path-based KV routing for workspace content |
| Publish sync | `src/cli/publish.ts`, `src/cli/publish_workspace.ts` | Sync `soul.md`, `skills/*`, and `memories/*` |
| Broker config registration | `src/cli/publish.ts`, broker registry modules | Keep `agent.json` broker-owned and out of private workspace KV |

## Consequences

**Positive:**

- deploy ownership becomes clearer: broker config vs agent workspace
- no filesystem dependency for deployed agent workspace content
- `skills/*`, `memories/*`, and eventually `soul.md` share one coherent deploy
  model
- file tools remain the agent's interface — no new workspace tool surface
  needed

**Negative:**

- KV has size limits (64 KB per value) — large files may need chunking
- one-way sync still means remote edits can drift from local until explicit
  reconcile flows exist
- two concerns now need to stay clearly separated in docs and code:
  broker-owned config and agent-owned content

## Alternatives considered

1. **Bundle all workspace content into the Deploy binary.**
   Rejected: does not support runtime writes to memories or future skill
   lifecycle features.

2. **Use external storage (S3/R2) for workspace content.**
   Rejected: KV is native to Deploy and keeps the deploy story simpler.

3. **Put `agent.json` in the agent-private workspace KV.**
   Rejected: it duplicates control-plane state and conflicts with the broker's
   role as the canonical policy/routing owner.

4. **Use Prisma Postgres for workspace content.**
   Rejected: overkill for small text files. Postgres remains better reserved for
   heavier conversational and memory data.
