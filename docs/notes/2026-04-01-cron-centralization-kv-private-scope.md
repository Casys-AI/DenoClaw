# Cron/Heartbeat centralization + KV private scope review

Date: 2026-03-31 Status: cron implemented; KV/data-plane/federation follow-up
open

## 1. Cron & Heartbeat — move to broker

Status: implemented

Today each agent runtime opens its own KV and manages its own `CronManager` +
heartbeat. This is inconsistent with the broker-as-control-plane principle
stated in AGENTS.md:

> "The Broker is the control plane: ingress, auth, routing, **scheduling**,
> observability."

### Implemented shape

- Broker owns scheduling through `BrokerCronManager` (cron persistence,
  `Deno.cron` registration, broker boot reload).
- Cron fires are dispatched as normal broker-owned `task_submit` messages to the
  target agent.
- Agent runtime stays reactive. It no longer owns cron/heartbeat lifecycle.
- Broker-derived liveness replaced agent-side heartbeat writes.
- Agent-facing cron tools now cover create/list/delete/enable/disable.
- Broker monitoring exposes `/cron/jobs` for the deployed control plane.

### Impact

- `src/agent/cron.ts` is deleted.
- `src/agent/runtime.ts` no longer uses KV for heartbeat; deploy-mode KV access
  remains for skills/memories.
- Local dev and deploy now share the same broker-owned cron model.
- Cron coverage now includes create/list/delete/enable/disable plus fire/reload
  behavior.

## 2. KV private scope — skills, soul, workspace files

→ **Moved to ADR-018** (`adr-018-workspace-kv-backend-for-deploy.md`)

Already planned in ADR-009 (dual model) and ADR-012 (workspace structure).
ADR-018 covers the concrete implementation: KvWorkspaceLoader, KvSkillsLoader,
file tool routing, publish sync step, and skills lifecycle direction.

## 3. Relation to ADK integration

Both changes align with a potential ADK integration:

- Centralized scheduling matches ADK's Runner-as-orchestrator model.
- KV-backed workspace + session state aligns with ADK's `SessionService` pattern
  (state persisted by the runner, not by the agent itself).
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
- **Embeddings via pgvector** — semantic recall, vector search natively in
  Postgres

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

## 5. Federation → A2A standard alignment

### Current state

The federation layer uses a **custom internal protocol**:

- `RemoteAgentCatalogEntry` (custom agent discovery format)
- `BrokerTaskSubmitPayload` (custom task format)
- `SignedCatalogEnvelope` (custom signed catalog)
- WebSocket tunnels as transport

There is **no A2A protocol** (JSON-RPC 2.0, Agent Cards, standard
tasks/messages/artifacts) in the federation layer today.

### Problem

DenoClaw agents cannot interop with the broader A2A ecosystem (ADK Google,
LangChain, Mastra, etc.) without custom bridge code. The federation is a closed
system.

### Proposed change

Keep the existing federation infrastructure (tunnels, trust model, link
lifecycle, routing policies, dead letter queue, stats/observability) — this is
**more robust** than what A2A standard provides out-of-the-box.

Replace the **payload format** inside tunnels with A2A standard:

- `RemoteAgentCatalogEntry` → **A2A Agent Cards** (`.well-known/agent.json`)
- `BrokerTaskSubmitPayload` → **A2A JSON-RPC 2.0 task messages**
- Task results/streaming → **A2A SSE events**
- Agent discovery → **A2A Agent Card resolution**

### What DenoClaw federation adds on top of A2A standard

| Capability     | A2A standard                | DenoClaw federation                                            |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| Transport      | HTTP request/response + SSE | Persistent WebSocket tunnels                                   |
| Trust model    | HTTPS + API keys/OAuth      | Signed identities, key rotation, trust states                  |
| Link lifecycle | None (stateless)            | opening→active→degraded→closed + heartbeat                     |
| Routing        | Client knows target         | Policy-based (prefer local, deny/allow lists, max latency)     |
| Reliability    | Caller retries              | Dead letter queue, idempotency keys, submission records        |
| Observability  | Not specified               | p50/p95 latency per link, denial breakdowns, trace correlation |

### ADK integration opportunity

With `@google/adk` A2A support (TypeScript SDK):

- Expose DenoClaw agents as `A2AServer` → any A2A client can reach them
- Consume external agents via `RemoteA2aAgent` → agents use remote A2A services
  as local tools
- Events flow naturally through A2A task messages across broker boundaries

This makes DenoClaw federation interoperable with the entire A2A ecosystem while
keeping its operational advantages.

## Remaining TODO

- [ ] Prototype KvWorkspaceLoader adapter
- [ ] Decide: traces stay on shared KV or route through broker
- [ ] Design Prisma schema for sessions + state + memory + embeddings
- [ ] Prototype DenoKvSessionService (lightweight) vs PrismaSessionService
      (full)
- [ ] Evaluate pgvector embedding dimensions (OpenAI 1536 vs smaller models)
