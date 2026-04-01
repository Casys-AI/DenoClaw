# Agent core evolution strategy for DenoClaw

Date: 2026-03-31 (updated 2026-04-01)
Status: open discussion

## Summary

After evaluating LangChain, LangGraph, Mastra, Vercel AI SDK, Google ADK,
AgentForce ADK, @alphaxiv/agents, and several Deno-native libs, the strategy
is:

- **Implement a Deno-native agent core** (working name: **Kaku** 核) inspired
  by ADK patterns but without the ADK dependency
- **Use Mastra `@mastra/memory`** for the memory layer (pluggable, swappable
  with Cognee or custom later)
- **Implement A2A protocol natively** (JSON-RPC 2.0 + SSE on `Deno.serve`,
  no `@a2a-js/sdk` dependency)

## Why not import ADK directly

ADK (`@google/adk`) was validated on Deno (POC passes), but:

- **No selective imports** — single barrel export, no subpath exports
- **Heavy dependencies** — MikroORM (all DB drivers), express, winston,
  google-auth-library, Google Cloud exporters, protobuf/gRPC
- 300+ npm packages installed for ~15-20% useful surface
- Node-centric assumptions (express server, MikroORM, winston logging)

Decision: **inspire from ADK patterns, implement Deno-native**.

## Why not import @a2a-js/sdk

- npm-only, peer deps on express + gRPC + protobuf
- A2A protocol is simple: JSON-RPC 2.0 over HTTP + SSE + Agent Cards
- Implementable in a few hundred lines with `Deno.serve` + `fetch`

Decision: **implement A2A client/server natively**.

## What we take from ADK (patterns, not code)

### Event loop (yield/pause/resume)

Replace the current `while` loop in `loop_process.ts` and
`runtime_conversation.ts` with an event-driven model:

- Agent yields typed events (LLM response, tool call, state delta, delegation)
- Runner receives event, commits side effects (state, memory), forwards
  upstream
- Agent resumes only after commit
- Each event is observable, persistable, interruptible

### Middleware/onion pattern (Koa/Hono style)

The agent loop becomes a composable pipeline:

```typescript
agent
  .use(sessionMiddleware(store))       // session.state management
  .use(memoryMiddleware(mastraMemory)) // long-term memory injection
  .use(toolMiddleware(tools))          // tool execution
  .use(a2aMiddleware())                // A2A delegation
  .use(observabilityMiddleware())      // tracing/events
```

This allows users to plug in what they want. Memory is swappable
(Mastra today, Cognee tomorrow, custom later).

### Session state with scoped prefixes

New concept not present in DenoClaw today:

- No prefix → session-scoped (current conversation)
- `user:` prefix → user-scoped (across sessions)
- `app:` prefix → app-scoped (across users)
- `temp:` prefix → invocation-scoped (discarded after)

Persisted via `SessionService` adapter (KV or Prisma Postgres).

### Workflow agents

Deterministic orchestration primitives:

- Sequential (steps in order)
- Parallel (branches)
- Loop (until condition)
- Custom (user-defined)

### Resume / crash recovery

Events are persisted. On restart, replay completed events and resume from
last uncommitted step.

## Mastra for memory (kept)

POC validated: `@mastra/memory` works standalone on Deno without full Mastra
runtime. `@mastra/pg` (PostgresStore) works independently.

### What Mastra provides

- Observational Memory (Observer + Reflector, 5-40× compression, self-hosted)
- Semantic Recall (RAG with pgvector, 17+ vector stores)
- Working Memory (structured persistent data)
- Memory Processors (trim, filter, prioritize)
- Multi-agent memory scoping (resource/thread isolation)
- Retrieval mode (experimental recall tool)

### Pluggability

Memory is behind a port/interface. Mastra is the default implementation.
Can be swapped for Cognee or custom without touching the core.

## Validation schema

Using `@cfworker/json-schema` (JSR, zero deps, Deno-native) instead of
Ajv (Node-centric) or Zod (if lighter validation suffices).

## Scope of changes in src/agent/

The refactoring is **targeted**, not a rewrite:

| What changes | Files | ~Lines |
|---|---|---|
| Event loop (middleware/onion) | `loop.ts`, `loop_process.ts`, `runtime_conversation.ts` | ~400 |
| Memory port v2 (Mastra compat) | `memory.ts`, `memory_kvdex.ts`, `memory_port.ts` | ~350 |
| Session state (new) | new file(s) | ~150 |
| Cron → broker (move) | `cron.ts` | ~100 |

**Total: ~1000 lines touched/added.**

### Unchanged

- Tools + tool registry (`tools/`)
- Sandbox backends (`tools/backends/`)
- Worker pool + lifecycle (`worker_*.ts`)
- Workspace loader (`workspace.ts`)
- Context builder (`context.ts`)
- Skills loader (`skills.ts`)
- Deploy runtime (`deploy_runtime.ts`)
- Broker, federation, channels, transport

## Adapters (still needed)

Even without ADK as dependency, the adapter pattern remains:

- **`SessionService`** interface (our own, inspired by ADK)
  - `DenoKvSessionService` — lightweight, for session.state in KV
  - `PrismaSessionService` — full, for conversation history + state in Postgres
- **`MemoryService`** interface (our own, wrapping Mastra)
  - `MastraMemoryAdapter` — delegates to `@mastra/memory` + `@mastra/pg`
  - Future: CogneeAdapter, custom, etc.

## Persistence architecture (unchanged from companion note)

- **Deno KV**: control plane (auth, status, workspace files, caches)
- **Prisma Postgres + pgvector**: data plane (sessions, state, conversations,
  embeddings, long-term memory)

## A2A implementation status

A2A client + server are implemented natively (`A2AClient`, `A2AServer`).
Federation alignment is done (ADR-019):
- ~~Replace custom `BrokerTaskSubmitPayload` with A2A JSON-RPC messages~~ — payloads are A2A-shaped
- ~~Replace `RemoteAgentCatalogEntry` with A2A Agent Cards~~ — `card: AgentCard | null`, propagated via catalog sync
- Tunnel infrastructure preserved (trust, routing, dead letters, stats)
- SEC-19 fixed: broker identity verified before catalog sync

## Potential JSR publication

If the agent core matures enough, extract as:
- `jsr:@denoclaw/kaku` or `jsr:@casys/kaku` — the agent runtime core
- Separate from DenoClaw (the full platform with broker, federation, channels)

## Next steps

- [x] POC: ADK runs on Deno (validated, but won't import — too heavy)
- [x] POC: Mastra Memory runs standalone on Deno (validated)
- [x] Implement A2A client (fetch + SSE) — `A2AClient`
- [x] Implement A2A server (Deno.serve handler) — `A2AServer`
- [x] Federation A2A consolidation (ADR-019) — typed cards, catalog propagation, SSE compliance, deprecated alias cleanup, SEC-19
- [x] Move cron to broker
- [ ] Design event types + middleware interface (Kaku core)
- [ ] Implement minimal event loop with 1 middleware
- [ ] Implement session.state with scoped prefixes
- [ ] Wire Mastra Memory behind MemoryService adapter
- [ ] Migrate `loop_process.ts` to new event loop
