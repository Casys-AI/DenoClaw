# ADR-009: Agent Memory — KV Conversations + Long-Term Markdown

**Status:** In progress **Date:** 2026-03-27 **Last updated:** 2026-03-27

## Context

DenoClaw agent memory used to be one `Message[]` blob in Deno KV. There was no
indexing, no search, no long-term memory, and no DDD interface. The agent
workspace refactor is the right moment to restructure memory.

After a broad survey of the ecosystem (kvdex, denodata, kv-toolbox, Serena,
OpenClaw, NanoClaw, PicoClaw, Mem0, Zep, Letta, CrewAI), the decision is a
**dual model**:

- **Short-term (conversations)** → structured KV through kvdex
- **Long-term (knowledge)** → Markdown files
  (OpenClaw/Serena/NanoClaw pattern)

## Decision

### Short-term: kvdex for conversations ✅ IMPLEMENTED

kvdex (`@olli/kvdex@^3`) structures conversations in each agent's private KV:

- Typed collections with secondary `sessionId` index
- Sorted by `seq`, trimmed to `maxMessages` while preserving system messages
- Synchronous in-memory cache for `getMessages()` on the loop hot path
- Automatic compression/segmentation when exceeding the 64 KB limit
- `MemoryPort` DDD interface, so the loop depends on the interface, not the implementation

**Why kvdex instead of raw KV:** conversations are structured data
(session × seq × role) and benefit directly from secondary indexes and
compression. kvdex adds little surface area and high value for this workload.

### Long-term: dual backend (files locally, KV in Deploy) ⏳ TO IMPLEMENT

Each agent has a `memories/` directory inside its workspace:

```
./data/agents/alice/          ← project-level (ADR-012)
  agent.json                  ← config
  soul.md                     ← system prompt
  skills/                     ← skills .md
  memories/                   ← long-term knowledge (.md)
    project.md
    user_preferences.md
    learned_patterns.md

~/.denoclaw/agents/alice/     ← machine-level (runtime)
  memory.db                   ← KV conversations (kvdex)
```

**Dual backend by environment:**

| Environment      | Backend                                  | Source of truth |
| ---------------- | ---------------------------------------- | --------------- |
| Local (dev/VPS)  | `.md` files (`data/agents/<id>/memories/`) | Filesystem      |
| Deploy (deployed agents) | KV (`["memories", agentId, filename]`) | KV              |

Locally, the `.md` files are git-friendly, editable, and reviewable in PRs. On
Deploy there is no filesystem, so everything lives in KV. The content remains
the same Markdown; only the storage layer changes.

**Sync on deployment:** `deploy:agent` reads local `.md` files and copies them
into the deployed agent's KV. `soul.md` and `skills/` follow the same pattern.

**No special tool.** The agent uses the existing file tools (`read_file`,
`write_file`) to read and write its memories, just like Claude Code.

Locally, the tools access the real filesystem. On Deploy, the tools detect
`memories/` paths and transparently switch to a KV-backed implementation. The
agent does not know which backend is active.

```
Agent: write_file("memories/user_prefs.md", "Prefers French")
→ Local:  Deno.writeTextFile("data/agents/alice/memories/user_prefs.md", ...)
→ Deploy: kv.set(["workspace", "alice", "memories/user_prefs.md"], ...)
```

**At startup:** the system prompt receives the list of memory files so the
agent knows what it has already stored.

## Why this dual model

### Why KV for short-term memory

- Conversations are ordered message sequences, a natural KV workload
- Trimming the window requires atomic operations
- A synchronous cache is necessary for the loop hot path
- Humans do not need to read raw conversation storage
- It works on Deno Deploy where no filesystem exists

### Why Markdown for long-term memory

- **Human-readable** — you can open `user_preferences.md` and fix a wrong fact
- **Git-friendly** — memories diff cleanly, can be committed, and can be reviewed
- **Natural consolidation** — the agent can summarize by rewriting a paragraph
  instead of requiring a bi-temporal fact system
- **Established pattern** — OpenClaw (`MEMORY.md` + `memory/YYYY-MM-DD.md`),
  NanoClaw (`CLAUDE.md` per group), Serena (`.serena/memories/`), Claude Code (`memory/`)
- **No automatic eviction** — long-term memory should not disappear by itself
- **Extensible** — vector search can be layered on top later
  (embeddings, memsearch, LanceDB)

### Why not put everything in KV

The exploration showed that long-term knowledge in KV creates fundamental
problems:

- **Opaque** — a SQLite `.db` is not human-readable or editable
- **No natural consolidation** — you end up designing a bi-temporal system
  (FactRecord, superseded/consolidated states, versionstamp CAS) for something
  Markdown already handles naturally
- **Unbounded growth** — without compaction, facts accumulate; kvdex does not
  provide built-in pruning
- **Not git-friendly** — you cannot review an agent's knowledge in a PR

### Why not put everything in Markdown

Conversations do not fit file storage well:

- High volume (hundreds of messages per session)
- Need for atomic trimming and pagination
- No need for humans to read raw conversation logs
- Deno Deploy has no filesystem, so KV is mandatory

## Evaluated and rejected options

### denodata

Interesting 50+ search operators, but the project is **abandoned** (last commit
September 2023, v0.0.28-beta, 15 stars). TTL cleanup is lazy, only on read. The
API is incompatible with Deno 2.x. **Rejected.**

### kv-toolbox

Supports blobs larger than 64 KB, encryption, and batched atomics.
**Complementary**. It can be added later for at-rest encryption or large
artifacts, but it is unnecessary for conversation or long-term memory today.

### Everything in kvdex (long-term memory in KV)

This was implemented and then reconsidered. kvdex supports `expireIn` (native
Deno KV TTL) and `count()`, but:

- No built-in compaction or consolidation
- No deduplication
- Facts in KV stay opaque to humans
- No serious agent framework uses this pattern

### Raw bi-temporal KV (FactRecord, versionstamp CAS)

Explored in depth using ordered keys
`["facts", agentId, topic, timestampMs]`, active/by-id/by-tx indexes, and
atomic consolidation through `kv.atomic().check()`. Technically correct, but
**over-engineered** for the actual need. A single `project.md` file edited by
the agent does the same job with 10x less code.

### Symbolic search (SWC / LSP)

Deno has `deno_ast` (Rust SWC parser), exposed in WASM through `@jsz/swc` and
`@deco/deno-ast-wasm` on JSR. It parses TypeScript and JavaScript only, unlike
Serena's multi-language LSP approach. **Relevant for a future `code_analyze`
tool, not for long-term memory.**

## Research: memory patterns in the ecosystem

### Agent frameworks — how they handle memory

| Framework        | Short-term              | Long-term                            | Search                                            | Consolidation                               |
| ---------------- | ----------------------- | ------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| **OpenClaw**     | Messages in context     | `MEMORY.md` + `memory/YYYY-MM-DD.md` | LanceDB semantic search (`memsearch`)             | Agent auto-writes before context compaction |
| **NanoClaw**     | SQLite messages         | `CLAUDE.md` per group                | —                                                 | Agent edits the `.md`                       |
| **Serena**       | —                       | `.serena/memories/*.md`              | List + read                                       | Agent writes/edits through tools            |
| **Letta/MemGPT** | Context window (RAM)    | Core blocks + archival (vector DB)   | Embedding search                                  | Recursive summarization + sleep-time agents |
| **CrewAI**       | RAG short-term          | LanceDB + SQLite                     | Composite score (semantic × recency × importance) | LLM-assisted dedup (cosine > 0.85)          |
| **Mem0**         | —                       | Vector store + knowledge graph       | Hybrid vector + graph                             | LLM-as-router (ADD/UPDATE/DELETE/NOOP)      |
| **Zep/Graphiti** | Episodes (raw messages) | Bi-temporal knowledge graph          | Vector + BM25 + graph traversal                   | Edge dedup + community summaries            |

### Observed convergence (2025-2026)

1. **Tiered memory** — everyone separates short-term (structured/DB) from
   long-term (documents/files)
2. **Markdown as source of truth** — OpenClaw, NanoClaw, Serena, and Claude
   Code all use `.md`
3. **Vector search as an additional layer** — added on top of documents, not as
   the primary storage layer
4. **No hard delete for long-term memory** — either soft decay or explicit edit
5. **Sleep-time consolidation** — Letta, Google, and Claude Code all perform
   memory maintenance while idle
6. **LLM-as-memory-router** — the Mem0 pattern (the agent chooses
   ADD/UPDATE/DELETE) is spreading

### Relevant Deno primitives for later

| Primitive                          | Potential use                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `Deno.cron()`                      | Sleep-time consolidation (background memory maintenance). Note: `kv.enqueue()` is deprecated on new Deploy, so use cron directly. |
| `kv.watch()`                       | Cross-agent memory events (max 10 keys, sentinels)                            |
| `.sum()` / `.max()` (atomics CRDT) | Fact counters without locks                                                   |
| `@jsz/swc` / `@deco/deno-ast-wasm` | Future `code_analyze` tool (parse TS AST in WASM)                             |
| `kv-toolbox` blob + crypto         | Future at-rest encryption, artifacts > 64 KB                                  |

## Current implementation state

### ✅ Done

- `MemoryPort` DDD interface (`src/agent/memory_port.ts`)
- `KvdexMemory` adapter for conversations (`src/agent/memory_kvdex.ts`)
- `Memory implements MemoryPort` fallback (`src/agent/memory.ts`)
- `WorkspaceLoader` workspace CRUD (`src/agent/workspace.ts`)
- `MemoryTool` KV-backed with 4 actions (`src/agent/tools/memory.ts`)
- Topics injected into the system prompt (`src/agent/context.ts`, `loop.ts`)
- Workspace-backed CLI (`src/cli/agents.ts`)
- Workspace + registry config merge (`src/config/loader.ts`)
- `getAgent*()` + `validateAgentId()` helpers (`src/shared/helpers.ts`)
- Unified runtime with `MemoryPort` (`src/agent/runtime.ts`)
- Worker wiring for `KvdexMemory` + `ensureDir` (`worker_entrypoint.ts`,
  `worker_pool.ts`)
- 95 tests pass, type-check passes, lint clean

### ⏳ To do — long-term memory through file tools

1. `WorkspaceLoader.create()` creates `memories/` under `data/agents/<id>/`
2. `read_file` / `write_file` tools detect `memories/` paths and transparently
   route to the filesystem (local) or KV (Deploy)
3. Update `context.ts` to inject the list of memory files into the prompt
4. `deploy:agent` syncs local `.md` files into KV at deployment time
5. Add tests for filesystem/KV routing in the file tools

### 🔮 Future (out of scope)

- Semantic search on `.md` files (embeddings, memsearch, LanceDB)
- Sleep-time consolidation via `Deno.cron()` + `kv.enqueue()`
- Cross-agent memory events through `kv.watch()` sentinels on shared KV
- `code_analyze` tool built on SWC WASM (`@jsz/swc`)
- Memory encryption through `kv-toolbox` crypto
- Automatic onboarding (Serena pattern: the agent analyzes the project on first launch)

## Consequences

- Long-term memory becomes readable, editable, and git-friendly
- The dual model (KV + `.md`) covers both use cases without over-engineering
- The architecture can grow into vector search without a storage rewrite
- Compatible with local mode (filesystem) and Deploy (KV behind the same tools)
- `deploy:agent` syncs local workspace → remote KV (`soul.md`, `skills/`, `memories/`)
- No special memory tool is required; `read_file` / `write_file` are enough
- Follows the Claude Code pattern: the agent manages its memories as files
