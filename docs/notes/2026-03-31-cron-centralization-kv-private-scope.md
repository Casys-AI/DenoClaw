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

## 4. Persistence architecture for Deno Deploy

### Constraint

On Deno Deploy, available persistence options are:
- **Deno KV** (native, zero-config)
- **Prisma Postgres** (Deno Deploy managed)
- **External HTTP services** (Turso remote, Supabase, etc.)

LibSQL/SQLite embedded is **not available** on Deploy.

### Proposed split

**Deno KV — control plane (lightweight state):**
- Auth tokens (invite, session, agent)
- Agent status / heartbeat / monitoring
- Workspace files (soul, skills, config — see §2)
- Caches, flags, coordination

**Prisma Postgres — data plane (conversational + memory):**
- Session history (messages, events, full conversation)
- Session state (ADK-style key-value with prefixes: session/user/app/temp)
- Long-term memory (cross-session, searchable)
- **Embeddings via pgvector** — semantic recall, vector search natively in Postgres

### Why this split

- KV excels at small key-value lookups, bad at large serialized blobs and
  partial queries on conversation history.
- Prisma Postgres gives SQL queries, pagination, partial reads, relational
  joins, and pgvector for embeddings — all in one backend.
- Both are Deno Deploy native. No external infra needed.

### ADK alignment

- `SessionService` adapter → Prisma Postgres (sessions + state + events)
- `MemoryService` adapter → Prisma Postgres (pgvector for semantic search)
- Workspace/config loading → Deno KV (private per-agent)
- Control plane coordination → Deno KV (shared)

This gives the full ADK memory model (session state, conversation history,
long-term semantic memory) on Deploy-compatible infra.

## TODO

- [ ] Verify cron jobs currently registered by agents — what schedules exist
- [ ] Design broker-side scheduling API (or reuse existing broker cron if any)
- [ ] Prototype KvWorkspaceLoader adapter
- [ ] Decide: traces stay on shared KV or route through broker
- [ ] Design Prisma schema for sessions + state + memory + embeddings
- [ ] Prototype DenoKvSessionService (lightweight) vs PrismaSessionService (full)
- [ ] Evaluate pgvector embedding dimensions (OpenAI 1536 vs smaller models)
