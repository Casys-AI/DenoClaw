# ADR-014: Agent Configuration Hot-Reload

**Status:** Proposed **Date:** 2026-03-29 **Related:** ADR-012

## Context

When local authoring files under `data/agents/<id>/` change, the gateway must
currently be restarted. This breaks active local conversations and disconnects
running workers.

The ownership split is now clearer:

- `agent.json` is the local authoring surface for broker-owned control-plane
  config
- `soul.md` and `skills/` are local authoring surfaces for agent-owned
  workspace content

This ADR covers **local filesystem watch behavior only**. It does not define
how Deploy picks up those changes after publish.

## Decision

Use `Deno.watchFs()` to monitor `data/agents/` for changes and reload affected
agents at runtime in local mode.

### What triggers a reload

| Change                  | Effect                                                |
| ----------------------- | ----------------------------------------------------- |
| `agent.json` modified   | Reload local runtime config (peers, acceptFrom, execPolicy) |
| New agent directory     | Spawn new worker via `WorkerPool.addAgent()`          |
| Agent directory deleted | Graceful shutdown of worker                           |

### What does NOT trigger a reload

| Change                    | Reason                                                 |
| ------------------------- | ------------------------------------------------------ |
| `soul.md` modified        | Loaded once at worker start — immutable per session    |
| `skills/` modified        | Loaded once at worker start — immutable per session    |
| `~/.denoclaw/config.json` | Global config (providers, API keys) — requires restart |
| `memory.db`               | Runtime data, not config                               |
| `.env` changes            | Process-level, requires restart                        |

### Implementation

```typescript
// In Gateway or WorkerPool
const watcher = Deno.watchFs("./data/agents/", { recursive: true });

for await (const event of watcher) {
  if (
    event.kind === "modify" || event.kind === "create" ||
    event.kind === "remove"
  ) {
    const agentId = extractAgentIdFromPath(event.paths[0]);
    if (agentId) {
      await reloadAgent(agentId);
    }
  }
}
```

Reload strategy:

1. Read updated workspace via `WorkspaceLoader.load(agentId)`
2. If agent exists in pool → update config in-place (no worker restart for
   config-only changes)
3. If new agent → `WorkerPool.addAgent(agentId)`
4. If deleted → `WorkerPool.removeAgent(agentId)` with graceful shutdown

### Debouncing

File watchers emit multiple events for a single save. Debounce with a 500ms
window per agent to avoid redundant reloads.

### Scope exclusions

This ADR does **not** cover:

- broker KV synchronization for deploy-time agent config
- agent-private workspace KV synchronization for deploy-time `soul.md` or
  `skills/*`
- publish/reconcile behavior for Deploy

### What is reloadable vs what requires restart

**Reloadable at runtime** (local WorkerPool re-reads `agent.json`, no worker
restart):

- `peers`, `acceptFrom` — checked at routing time, not cached in worker
- `execPolicy` — checked at tool execution time

**Requires worker restart** (identity change — destroy + recreate worker):

- `model` — baked into AgentLoop config
- `sandbox.allowedPermissions` — baked into subprocess spawn flags

**Agent-initiated reload** (not auto-watched, reloaded on demand):

- `soul.md` — the agent can re-read its own soul via tool/instruction
- `skills/` — the agent can reload skills via SkillsLoader.loadSkills()

## Consequences

**Positive:**

- Zero-downtime config updates
- Add/remove agents without gateway restart
- Natural workflow: edit `agent.json` → local gateway changes apply
  automatically
- Compatible with `git pull` deploying new agent configs

**Negative:**

- File watcher adds a background goroutine
- Debounce logic adds complexity
- Race condition risk: config change during active conversation
- `Deno.watchFs()` behavior may vary by OS (polling on some platforms)
- Deploy still needs an explicit publish/sync step; watchFs is not the deploy
  propagation mechanism
