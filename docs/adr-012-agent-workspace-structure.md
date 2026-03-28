# ADR-012: Agent Workspace Structure — Definition vs Runtime Split

**Status:** Proposed
**Date:** 2026-03-28
**Supersedes:** None
**Related:** ADR-001, ADR-008, ADR-011

## Context

Agent data currently lives entirely in `~/.denoclaw/agents/<id>/`:

```
~/.denoclaw/agents/alice/
├── agent.json    ← agent definition (config, permissions, peers)
├── soul.md       ← system prompt
├── skills/       ← custom skills
└── memory.db     ← KV private (conversations)
```

This creates three problems:

1. **Not deployable.** Subhosting deployment needs agent definitions (config, soul, skills) bundled with the deployment. Files in `~/` are machine-local and cannot be deployed from CI/CD.

2. **Not versionable.** Agent definitions describe _what the agent is_ — they are source artifacts. Storing them outside the project prevents `git add` and peer review of agent configuration changes.

3. **Mixed concerns.** Runtime data (memory.db, cron state) is co-located with static definitions (agent.json, soul.md). A `git add` of the workspace directory would accidentally commit conversation history.

## Decision

Split agent data into two locations by concern:

### Project-level: `./data/agents/<id>/` — Agent Definition

What the agent **is**. Versionable, deployable, portable.

```
./data/agents/<id>/
├── agent.json    ← config: permissions, peers, acceptFrom, model, description
├── soul.md       ← system prompt (personality, instructions)
└── skills/       ← custom tool definitions
```

- Checked into git (agent definitions are source artifacts)
- Read by `WorkspaceLoader` and `ConfigLoader.mergeWorkspaceAgents()`
- Bundled into Subhosting deployments by `setup.ts`
- Created by `denoclaw agent create`, deleted by `denoclaw agent delete`

### Machine-level: `~/.denoclaw/agents/<id>/` — Agent Runtime

What the agent **has done**. Machine-local, not versioned.

```
~/.denoclaw/agents/<id>/
└── memory.db     ← KV private (conversation history)
```

- Never committed to git
- Created lazily at runtime by `KvdexMemory`
- Machine-specific — different machines have different conversation histories
- Cleaned by `denoclaw agent delete` (optional, with `--keep-memory` flag)

### Shared runtime: `./data/shared.db` — Cross-agent State

```
./data/shared.db  ← dashboard, metrics, traces, cron state
```

- Gitignored (`.db` files)
- Injected into `MetricsCollector`, `WorkerPool`, `CronManager`
- Read by dashboard SSE stream

### Global config: `~/.denoclaw/config.json` — Secrets

```
~/.denoclaw/config.json  ← API keys, provider config
```

- Never versioned (contains secrets)
- Machine-level (different machines may have different keys)
- Merged with project-level agent definitions at load time

## Gitignore Rules

```gitignore
# Runtime databases (not versioned)
data/**/*.db
data/**/*.db-shm
data/**/*.db-wal

# Agent definitions ARE versioned
!data/agents/
!data/agents/*/
!data/agents/*/agent.json
!data/agents/*/soul.md
!data/agents/*/skills/
```

## Path Resolution

| Function | Current | New |
|---|---|---|
| `getAgentDefinitionDir(id)` | N/A | `./data/agents/<id>/` |
| `getAgentConfigPath(id)` | `~/.denoclaw/agents/<id>/agent.json` | `./data/agents/<id>/agent.json` |
| `getAgentSoulPath(id)` | `~/.denoclaw/agents/<id>/soul.md` | `./data/agents/<id>/soul.md` |
| `getAgentSkillsDir(id)` | `~/.denoclaw/agents/<id>/skills/` | `./data/agents/<id>/skills/` |
| `getAgentMemoryPath(id)` | `~/.denoclaw/agents/<id>/memory.db` | `~/.denoclaw/agents/<id>/memory.db` (unchanged) |
| `getAgentDir(id)` | `~/.denoclaw/agents/<id>/` | Removed — ambiguous, split into definition/runtime |

## Migration

On first load, `WorkspaceLoader` checks both locations:
1. Read from `./data/agents/<id>/agent.json` (new canonical path)
2. If not found, fall back to `~/.denoclaw/agents/<id>/agent.json` (legacy)
3. If found in legacy location, log a warning suggesting migration

A `denoclaw agent migrate` command moves definitions from `~/.denoclaw/` to `./data/agents/` while leaving `memory.db` in place.

## CronManager Integration

`CronManager` currently opens its own default KV independently. After this change:
- Cron **definitions** (schedules) become a field in `agent.json`: `{ "cron": [...] }`
- Cron **state** (lastRun, locks) persists in the shared KV (injected, not self-opened)
- `CronManager` receives the shared KV handle via constructor injection

## Consequences

**Positive:**
- Agent definitions are versionable and reviewable via git
- Subhosting deployment can bundle `./data/agents/<id>/` directly
- CI/CD can deploy agents without access to the developer's home directory
- Runtime data stays private and machine-local
- Clear separation makes backup/restore straightforward

**Negative:**
- Breaking change for existing agent locations (mitigated by fallback + migrate command)
- Two directories to check for "where is my agent" (mitigated by clear naming)
- `./data/` directory serves dual purpose (runtime DBs + static definitions)

## Alternatives Considered

1. **Everything in `./agents/`** — cleaner separation from `data/` but creates a new top-level directory. Rejected: `data/agents/` is consistent with existing `data/shared.db` location.

2. **Everything in `~/.denoclaw/`** — current state. Rejected: not deployable, not versionable.

3. **Config in `denoclaw.json`, no workspace files** — put all agent config in one file. Rejected: doesn't scale (soul.md can be large, skills are directories), harder to manage per-agent.
