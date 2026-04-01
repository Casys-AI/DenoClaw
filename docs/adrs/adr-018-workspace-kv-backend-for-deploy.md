# ADR-018: KV-Backed Workspace for Deploy

**Status:** Proposed
**Date:** 2026-04-01
**Related:** ADR-009 (memory dual model), ADR-012 (workspace structure)

## Context

ADR-009 established the dual model: filesystem locally, KV on Deploy. ADR-012
defined the workspace structure (`soul.md`, `skills/`, `agent.json`,
`memories/`). Both describe the target architecture but defer implementation.

Today, `WorkspaceLoader` and `SkillsLoader` read exclusively from the
filesystem (`Deno.readTextFile`, `Deno.readDir`). File tools (`read_file`,
`write_file`) also access the filesystem directly. This works locally but
**breaks on Deno Deploy** where agents have no access to the host filesystem.

The original gaps were around publish-time workspace sync and transparent KV
routing in file tools.

Implementation note as of 2026-04-01:

- deployed runtimes now read `skills/*` and `memories/*` from KV
- broker-owned `read_file` / `write_file` routes those workspace paths to KV in
  Deploy mode
- `denoclaw publish` now snapshots `skills/*` and `memories/*` with explicit
  sync modes: default `preserve`, optional `--force`
- `soul.md` and `agent.json` are still embedded in the generated entrypoint, so
  they are not yet part of the KV workspace contract

Additionally, skills management has a broader concern: skills may be installed
from remote sources (e.g., a skill registry), updated independently of the
agent deployment, and potentially need bidirectional sync between local
development and deployed agents.

## Decision

### 1. KvWorkspaceLoader adapter

Add a `KvWorkspaceLoader` that implements the same interface as
`WorkspaceLoader` but reads from the agent's private KV.

```
["workspace", agentId, "soul"]              → string (soul.md content)
["workspace", agentId, "config"]            → AgentEntry (JSON)
["workspace", agentId, "skills", skillName] → string (SKILL.md content)
["workspace", agentId, "memories", filename]→ string (.md content)
```

The runtime selects the loader based on environment:

```typescript
const loader = isDeployEnvironment()
  ? new KvWorkspaceLoader(kv, agentId)
  : WorkspaceLoader;
```

### 2. Transparent file tool routing

`read_file` and `write_file` detect workspace-relative paths and route to
the correct backend:

| Path pattern | Local | Deploy |
|---|---|---|
| `memories/*` | filesystem | KV `["workspace", agentId, "memories", ...]` |
| `skills/*` | filesystem | KV `["workspace", agentId, "skills", ...]` |
| `soul.md` | filesystem | KV `["workspace", agentId, "soul"]` |
| Other paths | filesystem | filesystem (if available) or error |

The agent code is identical in both environments. The routing is invisible.

### 3. Publish/sync step

`denoclaw publish` (or `deploy:agent`) serializes the local workspace into
the deployed agent's KV:

```
For each agent:
  1. Read soul.md → kv.set(["workspace", agentId, "soul"], content)
  2. Read agent.json → kv.set(["workspace", agentId, "config"], parsed)
  3. For each skills/*.md → kv.set(["workspace", agentId, "skills", name], content)
  4. For each memories/*.md → kv.set(["workspace", agentId, "memories", name], content)
```

This is **one-way** (local → Deploy) for now. The current implementation keeps
the sync intentionally narrow:

- default `preserve` only creates missing tracked files
- `--force` overwrites conflicting tracked files for that publish revision
- extra remote files are not deleted

Bidirectional sync and reconcile/status flows are deferred.

### 4. SkillsLoader KV adapter

`SkillsLoader` gains a KV-backed mode for Deploy:

```typescript
// Local: reads from filesystem (current behavior)
const loader = new SkillsLoader(skillsDir);

// Deploy: reads from KV
const loader = new KvSkillsLoader(kv, agentId);
```

Both implement the same interface (`loadSkills()`, `getSkills()`, `getSkill()`).

### 5. Skills lifecycle (future direction — out of scope)

Skills may come from:
- Local files (current)
- Remote registry (future: ClawHub-like for DenoClaw)
- Agent-installed at runtime (future: agent discovers and installs skills)

This ADR covers only the local → KV sync. A future ADR should address:
- Remote skill installation and versioning
- Bidirectional sync (deployed agent installs a skill → propagate back)
- Skill dependency resolution
- Skill hot-reload on deployed agents

## Implementation scope

| Component | File(s) | Change |
|---|---|---|
| KvWorkspaceLoader | `src/agent/workspace.ts` (new class) | New adapter |
| KvSkillsLoader | `src/agent/skills.ts` (new class) | New adapter |
| File tool routing | `src/agent/tools/file.ts`, `file_workspace.ts` | Add KV path detection |
| Publish sync | `src/cli/publish.ts`, `src/cli/publish_workspace.ts` | Snapshot local workspace and bootstrap remote KV |
| Environment detection | `src/shared/helpers.ts` | `isDeployEnvironment()` |
| Runtime wiring | `src/agent/runtime.ts`, `worker_entrypoint.ts` | Select loader by env |

## Consequences

**Positive:**
- Agents work identically on local and Deploy
- No filesystem dependency for deployed agents
- Skills and soul are available in sandboxed environments
- `publish` is a single step that syncs everything
- File tools remain the agent's interface — no new tools needed

**Negative:**
- KV has size limits (64 KB per value) — large skills may need chunking
  (unlikely for `.md` files, but possible for embedded assets)
- One-way sync means deployed agent memory writes are lost if you re-publish
  without pulling first (acceptable for now, addressed by future bidirectional
  sync)
- Two code paths (filesystem vs KV) increase test surface

## Alternatives considered

1. **Bundle workspace into the Deploy binary** — pack files at build time.
   Rejected: doesn't support runtime writes (memories, agent-installed skills).

2. **External storage (S3/R2) for workspace** — adds infra dependency.
   Rejected: KV is native to Deploy, zero config.

3. **Skip KV, use Prisma Postgres for workspace** — possible but overkill for
   small text files. KV is better suited for this (simple key → text lookups).
   Postgres is reserved for heavy data (conversations, embeddings).
