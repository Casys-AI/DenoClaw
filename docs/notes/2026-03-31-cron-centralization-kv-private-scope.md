# Cron/Heartbeat centralization + KV private scope review

Date: 2026-03-31
Status: open discussion

## 1. Cron & Heartbeat — move to broker

Today each agent runtime opens its own KV and manages its own `CronManager` +
heartbeat. This is inconsistent with the broker-as-control-plane principle
stated in AGENTS.md:

> "The Broker is the control plane: ingress, auth, routing, **scheduling**,
> observability."

### Proposed change

- Broker owns scheduling (cron jobs, heartbeat polling, health checks).
- Agent runtime becomes purely reactive — receives work, responds, done.
- Removes the need for agents to open shared KV just to write heartbeat status.
- Broker pings agents (or agents report on task completion), broker is source of
  truth for agent liveness.

### Impact

- `src/agent/cron.ts` moves to broker or becomes broker-dispatched.
- `src/agent/runtime.ts` no longer needs `getKv()` for heartbeat.
- Worker entrypoint no longer opens shared KV for heartbeat (tracing is a
  separate concern — may keep shared KV for that, or route traces through
  broker).

## 2. KV private scope — skills, soul, workspace files

Today skills and soul are loaded from the **filesystem**
(`WorkspaceLoader.load()` reads `soul.md`, `skills/`, `agent.json` from
`data/agents/<id>/`).

This works locally but breaks in Deploy/sandbox where the agent has no access
to the host filesystem.

### Proposed change

- Store soul, skills, agent config, and memory files in the agent's **private
  KV** (the one already opened per-agent at `kvPaths.private`).
- `WorkspaceLoader` gains a KV-backed adapter alongside the filesystem one.
- On `publish` / `sync-agents`, workspace files are serialized into private KV.
- Agent runtime reads from KV-backed workspace in Deploy, filesystem in local.

### Keys layout (draft)

```
["workspace", agentId, "soul"]           → string (soul.md content)
["workspace", agentId, "config"]         → AgentEntry JSON
["workspace", agentId, "skills", name]   → string (SKILL.md content)
["workspace", agentId, "memory", name]   → string (memory file content)
```

### Impact

- `src/agent/workspace.ts` needs a `KvWorkspaceLoader` adapter.
- `src/cli/publish.ts` needs to serialize workspace into KV during publish.
- Private KV path already exists (`kvPaths.private` in worker init).

## 3. Relation to ADK integration

Both changes align with a potential ADK integration:

- Centralized scheduling matches ADK's Runner-as-orchestrator model.
- KV-backed workspace + session state aligns with ADK's `SessionService`
  pattern (state persisted by the runner, not by the agent itself).
- Conversation memory migration from KV to SQLite/LibSQL is a separate but
  related discussion — KV private stays for lightweight workspace state, heavy
  conversation history moves to a proper DB.

## TODO

- [ ] Verify cron jobs currently registered by agents — what schedules exist
- [ ] Design broker-side scheduling API (or reuse existing broker cron if any)
- [ ] Prototype KvWorkspaceLoader adapter
- [ ] Decide: traces stay on shared KV or route through broker
