# ADR-014: Agent Configuration Hot-Reload

**Status:** Proposed
**Date:** 2026-03-29
**Related:** ADR-012

## Context

When an agent's configuration changes (agent.json, soul.md, skills/, or exec policy), the gateway must currently be restarted. This breaks all active conversations and disconnects all agents.

The gateway should detect config changes and apply them without restart.

## Decision

Use `Deno.watchFs()` to monitor `data/agents/` for changes and reload affected agents at runtime.

### What triggers a reload

| Change | Effect |
|--------|--------|
| `agent.json` modified | Reload agent config (permissions, peers, exec policy) |
| `soul.md` modified | Reload system prompt |
| `skills/` modified | Reload custom skills |
| New agent directory | Spawn new worker via `WorkerPool.addAgent()` |
| Agent directory deleted | Graceful shutdown of worker |

### What does NOT trigger a reload

| Change | Reason |
|--------|--------|
| `~/.denoclaw/config.json` | Global config (providers, API keys) — requires restart |
| `memory.db` | Runtime data, not config |
| `.env` changes | Process-level, requires restart |

### Implementation

```typescript
// In Gateway or WorkerPool
const watcher = Deno.watchFs("./data/agents/", { recursive: true });

for await (const event of watcher) {
  if (event.kind === "modify" || event.kind === "create" || event.kind === "remove") {
    const agentId = extractAgentIdFromPath(event.paths[0]);
    if (agentId) {
      await reloadAgent(agentId);
    }
  }
}
```

Reload strategy:
1. Read updated workspace via `WorkspaceLoader.load(agentId)`
2. If agent exists in pool → update config in-place (no worker restart for config-only changes)
3. If new agent → `WorkerPool.addAgent(agentId)`
4. If deleted → `WorkerPool.removeAgent(agentId)` with graceful shutdown

### Debouncing

File watchers emit multiple events for a single save. Debounce with a 500ms window per agent to avoid redundant reloads.

### Config-only vs full restart

Some changes can be applied without restarting the worker:
- **Config-only** (no worker restart): peers, acceptFrom, channels, description
- **Full restart** (worker must be recreated): model, systemPrompt, sandbox permissions, execPolicy

The distinction matters because a full restart loses the worker's in-memory conversation state (though KV-backed memory persists).

## Consequences

**Positive:**
- Zero-downtime config updates
- Add/remove agents without gateway restart
- Natural workflow: edit agent.json → changes apply automatically
- Compatible with `git pull` deploying new agent configs

**Negative:**
- File watcher adds a background goroutine
- Debounce logic adds complexity
- Race condition risk: config change during active conversation
- `Deno.watchFs()` behavior may vary by OS (polling on some platforms)
