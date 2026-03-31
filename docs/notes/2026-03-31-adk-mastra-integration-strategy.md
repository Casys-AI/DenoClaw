# ADK + Mastra integration strategy for DenoClaw

Date: 2026-03-31
Status: open discussion

## Summary

After evaluating LangChain, LangGraph, Mastra, Vercel AI SDK, Google ADK, and
several smaller Deno-native libs, the best strategy for DenoClaw is a **hybrid
ADK + Mastra** approach:

- **ADK** for the runtime layer (events, runner, A2A, workflow agents, session
  state, resume)
- **Mastra** for the memory layer (observational memory, semantic recall,
  working memory, memory processors)

## Why ADK for runtime

- Event loop with yield/pause/resume — each step observable, persistable,
  interruptible
- Crash recovery via event replay (resume stopped workflows)
- Workflow agents (Sequential, Parallel, Loop, Custom) — deterministic
  orchestration built-in
- A2A native (A2AServer + RemoteA2aAgent) — interop with entire ecosystem
- session.state with scoped prefixes (session/user/app/temp)
- Model-agnostic, TypeScript SDK available (`npm:@google/adk`)
- Philosophy aligns with DenoClaw: autonomous agents that collaborate, not
  nodes in a centralized graph

### What ADK doesn't do well (self-hosted)

- Advanced memory (observational, semantic recall, consolidation) is locked
  behind Vertex AI Memory Bank — not available self-hosted
- No Deno KV integration — custom adapters needed for SessionService
- No Prisma Postgres integration — custom adapters needed

## Why Mastra for memory

- Observational Memory: Observer + Reflector background agents compress old
  messages into dense observations (5-40× compression), fully self-hosted
- Semantic Recall: RAG-based search with 17+ vector store backends including
  PostgreSQL (pgvector)
- Working Memory: structured persistent data (names, prefs, goals) scoped per
  resource or thread
- Memory Processors: trim, filter, prioritize when context exceeds limits
- Multi-agent memory scoping: resource/thread isolation native, memory sharing
  between agents via matching identifiers
- Retrieval mode (experimental): recall tool to browse raw source messages
  behind compressed observations
- Storage backends: LibSQL, PostgreSQL, MongoDB, Upstash, Cloudflare D1,
  DynamoDB, LanceDB, MSSQL, Convex

### Mastra coupling concern

`@mastra/memory` depends on `@mastra/core` (Agent, storage interfaces). Two
approaches:

1. **Use @mastra/memory directly** — accept the dependency, wrap Mastra's
   Memory class behind ADK's MemoryService interface. Mastra handles the
   complex memory logic, ADK runner calls it via adapter.
2. **Reimplement Mastra patterns** — build Observer/Reflector/semantic recall
   on top of ADK's MemoryService interface using Prisma Postgres + pgvector.
   No Mastra dependency, but significant implementation work.

Decision: TBD — test option 1 first (evaluate coupling overhead).

## Comparison matrix

| Capability | ADK | Mastra | DenoClaw today |
|---|---|---|---|
| Event loop | yield/resume | generate/stream | while loop |
| Crash recovery | resume native | not documented | none |
| Workflow agents | Sequential/Parallel/Loop | separate workflows | none |
| A2A standard | native | supported | custom protocol |
| Session state | scoped prefixes | via working memory | none |
| Observational memory | Vertex AI only | self-hosted ✅ | none |
| Semantic recall | Vertex AI only | self-hosted ✅ | none |
| Working memory | via session.state | structured ✅ | none |
| Memory processors | none | native ✅ | none |
| Multi-agent memory | not documented | scoped ✅ | none |
| MCP tools | native | native | none |
| Storage | InMemory, Vertex AI | 10+ backends | Deno KV only |

## Persistence architecture (from companion note)

- **Deno KV**: control plane (auth, agent status, workspace files, caches)
- **Prisma Postgres + pgvector**: data plane (sessions, state, conversations,
  embeddings, long-term memory)

## Integration points in DenoClaw

### ADK integration (runtime)

- `src/agent/runtime.ts` → ADK Runner wrapping broker as transport
- `src/agent/runtime_conversation.ts` → replaced by ADK event loop
- `src/agent/loop.ts` + `loop_process.ts` → replaced by ADK agent.runAsync()
- New: `DenoKvSessionService` (session.state in KV)
- New: `PrismaSessionService` (conversation history in Postgres)
- `src/messaging/a2a/` → align with ADK A2A types

### Mastra integration (memory)

- New: `MastraMemoryAdapter` implementing ADK MemoryService interface
- Uses `@mastra/memory` with `@mastra/pg` storage (Prisma Postgres)
- Observational Memory with configurable LLM (via broker proxy)
- Semantic Recall with pgvector embeddings
- Working Memory for persistent agent scratchpad

### Unchanged

- Broker (control plane, routing, sandbox management)
- Federation (tunnels, trust, policies — payload format → A2A standard)
- Channels (Telegram, Discord, webhook)
- Worker pool + sandbox isolation

## Next steps

- [ ] POC: import `@google/adk` in DenoClaw, create one LlmAgent with
      FunctionTool, verify it runs on Deno
- [ ] POC: import `@mastra/memory` with `@mastra/pg`, test Memory class
      standalone (without full Mastra runtime)
- [ ] Design ADK Runner adapter that uses broker as LLM/tool proxy
- [ ] Design DenoKvSessionService + PrismaSessionService
- [ ] Design MastraMemoryAdapter implementing ADK MemoryService
- [ ] Evaluate @mastra/memory coupling — can it work without @mastra/core
      Agent class?
