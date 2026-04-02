# Session State with Scoped Prefixes

Date: 2026-04-02
Status: design approved

## Summary

Extend `SessionState` (currently a plain in-memory object) into a scoped,
persisted key-value map backed by a `SessionService` adapter. Keys carry a
prefix that determines their lifetime and visibility:

- No prefix → session-scoped: lives for the current conversation
- `user:` → user-scoped: persisted across sessions for a given user
- `app:` → app-scoped: shared across all users of the agent application
- `temp:` → invocation-scoped: discarded when `AgentRunner.run()` returns

This is the DenoClaw adaptation of ADK's `session.state` model. It slots
naturally into the Kaku middleware pipeline that already exists.

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Prefix encoding | Key prefix string (`user:`, `app:`, `temp:`) | Matches ADK, self-documenting, no extra field needed |
| State container type | `ScopedState` class wrapping a `Map` | Encapsulates prefix-aware get/set, no raw dict leakage |
| Persistence backend | `SessionService` port (KV or Postgres) | Follows DenoClaw's adapter pattern; swap without touching core |
| When to load | `sessionMiddleware` — before all other middlewares | State is available for every subsequent middleware |
| When to flush | `sessionMiddleware` — after `next()` returns | Flush only what changed; dirty-flag per key |
| `temp:` lifetime | Cleared in `sessionMiddleware` after flush | Simplest correct implementation; no async teardown needed |
| System prompt injection | `sessionMiddleware` sets `session.injectedState` | Memory middleware reads it and injects into context messages |
| Tool access to state | Via `state_change` event (existing) | Kernel already defines `StateChangeEvent`; no new mechanism needed |
| `conversationId` for persistence | From `session.sessionId` | Already available on `SessionState` |

## Architecture overview

```
AgentRunner.run()
   │
   ├─ sessionMiddleware (load from SessionService)
   │      │  ScopedState available in ctx.session.state
   │      ▼
   ├─ memoryMiddleware  (injects session.injectedState into messages)
   │      ▼
   ├─ contextRefreshMiddleware
   │      ▼
   ├─ toolMiddleware    (tools call state.set / emits StateChangeEvent)
   │      ▼
   └─ llmMiddleware
          │
          ▼  (all middlewares complete)
   sessionMiddleware flushes dirty keys → SessionService
   temp: keys cleared
```

### Scope rules

| Key pattern | Lifetime | Storage key structure |
|---|---|---|
| `name` | Current conversation | `session:{sessionId}:{name}` |
| `user:{name}` | Per-user, across sessions | `user:{userId}:{name}` |
| `app:{name}` | Per-app, global | `app:{agentId}:{name}` |
| `temp:{name}` | Current `run()` call only | In-memory only, never persisted |

`temp:` keys are never written to `SessionService`.

## Types and interfaces

### ScopedState

```typescript
// src/agent/session_state.ts

type StateScope = "session" | "user" | "app" | "temp";

interface ScopedStateEntry {
  value: unknown;
  dirty: boolean;
}

class ScopedState {
  private store: Map<string, ScopedStateEntry> = new Map();

  /** Parse prefix from raw key. */
  static scope(key: string): StateScope {
    if (key.startsWith("user:")) return "user";
    if (key.startsWith("app:")) return "app";
    if (key.startsWith("temp:")) return "temp";
    return "session";
  }

  get(key: string): unknown {
    return this.store.get(key)?.value;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, { value, dirty: true });
  }

  /** Return all entries that must be flushed. Excludes temp:. */
  dirtyPersisted(): Array<{ key: string; value: unknown; scope: StateScope }> {
    const result = [];
    for (const [key, entry] of this.store) {
      if (entry.dirty && ScopedState.scope(key) !== "temp") {
        result.push({ key, value: entry.value, scope: ScopedState.scope(key) });
      }
    }
    return result;
  }

  /** Clear temp: keys. Called after flush. */
  clearTemp(): void {
    for (const key of this.store.keys()) {
      if (key.startsWith("temp:")) this.store.delete(key);
    }
  }

  /** Load entries (already-fetched from SessionService). */
  load(entries: Array<{ key: string; value: unknown }>): void {
    for (const { key, value } of entries) {
      this.store.set(key, { value, dirty: false });
    }
  }

  /** Serialize session-scoped keys for system prompt injection. */
  toSessionContext(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of this.store) {
      if (ScopedState.scope(key) === "session") out[key] = entry.value;
    }
    return out;
  }
}
```

### SessionService port

```typescript
// src/agent/session_service.ts

interface SessionLoadRequest {
  sessionId: string;   // for session-scoped keys
  userId?: string;     // for user: keys (omit if no auth context)
  agentId: string;     // for app: keys
}

interface SessionFlushRequest extends SessionLoadRequest {
  entries: Array<{
    key: string;
    value: unknown;
    scope: "session" | "user" | "app";
  }>;
}

interface SessionService {
  load(req: SessionLoadRequest): Promise<Array<{ key: string; value: unknown }>>;
  flush(req: SessionFlushRequest): Promise<void>;
}
```

### Updated SessionState

```typescript
// src/agent/middleware.ts  (extended)

export interface SessionState {
  agentId: string;
  sessionId: string;
  userId?: string;          // NEW — used for user: scope routing
  taskId?: string;
  memoryTopics: string[];
  memoryFiles: string[];
  canonicalTask?: Task;
  runtimeGrants?: AgentRuntimeGrant[];
  state: ScopedState;       // NEW — replaces any ad-hoc per-run state
  injectedState?: string;   // NEW — populated by sessionMiddleware for memoryMiddleware
}
```

### sessionMiddleware

```typescript
// src/agent/middlewares/session.ts

export interface SessionMiddlewareDeps {
  service: SessionService;
}

export function sessionMiddleware(deps: SessionMiddlewareDeps): Middleware {
  return async (ctx, next) => {
    // Only initialize once per run (on llm_request iteration 0)
    if (ctx.event.type === "llm_request" && ctx.event.iterationId === 1) {
      const entries = await deps.service.load({
        sessionId: ctx.session.sessionId,
        userId: ctx.session.userId,
        agentId: ctx.session.agentId,
      });
      ctx.session.state.load(entries);
      // Inject session-scoped state into system prompt context
      const context = ctx.session.state.toSessionContext();
      if (Object.keys(context).length > 0) {
        ctx.session.injectedState = JSON.stringify(context);
      }
    }

    const resolution = await next();

    // Flush after every event that may have mutated state
    if (ctx.event.type === "tool_result" || ctx.event.type === "complete" || ctx.event.type === "error") {
      const dirty = ctx.session.state.dirtyPersisted();
      if (dirty.length > 0) {
        await deps.service.flush({
          sessionId: ctx.session.sessionId,
          userId: ctx.session.userId,
          agentId: ctx.session.agentId,
          entries: dirty,
        });
      }
      // Clear temp: after final flush
      if (ctx.event.type === "complete" || ctx.event.type === "error") {
        ctx.session.state.clearTemp();
      }
    }

    return resolution;
  };
}
```

## Adapter implementations

### DenoKvSessionService

```typescript
// src/agent/adapters/session_kv.ts

class DenoKvSessionService implements SessionService {
  constructor(private kv: Deno.Kv) {}

  async load(req: SessionLoadRequest): Promise<Array<{ key: string; value: unknown }>> {
    // Fetch all three scopes in parallel
    const [sessionEntries, userEntries, appEntries] = await Promise.all([
      this.listPrefix(["session", req.sessionId]),
      req.userId ? this.listPrefix(["user", req.userId]) : Promise.resolve([]),
      this.listPrefix(["app", req.agentId]),
    ]);
    return [...sessionEntries, ...userEntries, ...appEntries];
  }

  async flush(req: SessionFlushRequest): Promise<void> {
    const tx = this.kv.atomic();
    for (const { key, value, scope } of req.entries) {
      const kvKey = this.resolveKvKey(scope, key, req);
      tx.set(kvKey, value);
    }
    await tx.commit();
  }

  private resolveKvKey(scope: string, key: string, req: SessionLoadRequest): Deno.KvKey {
    if (scope === "session") return ["session", req.sessionId, key];
    if (scope === "user" && req.userId) return ["user", req.userId, key.slice("user:".length)];
    return ["app", req.agentId, key.slice("app:".length)];
  }

  private async listPrefix(prefix: Deno.KvKey): Promise<Array<{ key: string; value: unknown }>> {
    const results = [];
    for await (const entry of this.kv.list({ prefix })) {
      results.push({ key: entry.key.join(":"), value: entry.value });
    }
    return results;
  }
}
```

### PrismaSessionService

```typescript
// src/agent/adapters/session_prisma.ts

// Backed by a `session_state` table:
//   id          TEXT (scope:agentOrUserId:key)
//   value       JSONB
//   updated_at  TIMESTAMP
//
// Uses Prisma upsert in batches. Schema migration: new table, no changes to
// existing sessions or conversations tables.

class PrismaSessionService implements SessionService {
  constructor(private db: PrismaClient) {}

  async load(req: SessionLoadRequest): Promise<Array<{ key: string; value: unknown }>> { /* ... */ }
  async flush(req: SessionFlushRequest): Promise<void> { /* ... */ }
}
```

## How tools access state

Tools do not call `ScopedState` directly. They emit a `StateChangeEvent`:

```typescript
// Tool emits:
yield event<StateChangeEvent>({
  type: "state_change",
  key: "user:preferences",
  value: { theme: "dark" },
}, iteration);
```

`sessionMiddleware` observes `state_change` events (no resolution needed) and
calls `ctx.session.state.set(event.key, event.value)`.

The kernel already defines `StateChangeEvent` as an observation event — it
fires and forgets, the kernel does not wait for a resolution.

## System prompt injection

`memoryMiddleware` checks `ctx.session.injectedState` when building the system
message context:

```typescript
// In memoryMiddleware, when building messages for llm_request:
if (ctx.session.injectedState) {
  systemParts.push(`## Session state\n\`\`\`json\n${ctx.session.injectedState}\n\`\`\``);
}
```

This makes session-scoped state visible to the LLM without requiring a
dedicated tool call.

## Pipeline placement

`sessionMiddleware` must be the outermost middleware — before observability
even — so that state is loaded before any LLM call and flushed after all
side effects complete:

```typescript
// Local
pipeline
  .use(sessionMiddleware({ service: kvSessionService }))  // NEW, first
  .use(observabilityMiddleware(deps.tracer))
  .use(memoryMiddleware(deps.memory))
  .use(contextRefreshMiddleware(deps.contextRefresh))
  .use(toolMiddleware(deps.executeTool))
  .use(llmMiddleware({ getMessages, complete: deps.complete }))
```

## New / modified files

| File | Type | Change |
|---|---|---|
| `src/agent/session_state.ts` | New | `ScopedState` class, `StateScope` type |
| `src/agent/session_service.ts` | New | `SessionService` interface, `SessionLoadRequest`, `SessionFlushRequest` |
| `src/agent/middlewares/session.ts` | New | `sessionMiddleware` |
| `src/agent/adapters/session_kv.ts` | New | `DenoKvSessionService` |
| `src/agent/adapters/session_prisma.ts` | New | `PrismaSessionService` |
| `src/agent/middleware.ts` | Modified | Add `userId?`, `state: ScopedState`, `injectedState?` to `SessionState` |
| `src/agent/runner.ts` | Modified | Pass `userId` from deps; initialize `state: new ScopedState()` in factory fns |
| `src/agent/middlewares/memory.ts` | Modified | Read `session.injectedState` when building system prompt |

## What does not change

- `SessionState` fields that are already there (`agentId`, `sessionId`,
  `taskId`, `memoryTopics`, `memoryFiles`, `canonicalTask`, `runtimeGrants`)
  remain unchanged and untouched by this spec.
- The kernel (`kernel.ts`) — state is entirely a middleware concern.
- The `EventStore` interface — `StateChangeEvent` is already part of `AgentEvent`.
- `MemoryService` / Mastra memory — this is separate from conversation history;
  `ScopedState` holds structured data, Mastra holds messages.
- All tool implementations — tools only emit `StateChangeEvent`, which they
  could already do via `yield`.
- Broker, federation, channels, transport — untouched.

## Future extensions

- **TTL per scope**: `session_state` Postgres table gets an `expires_at` column;
  `DenoKvSessionService` uses the built-in KV expiry option.
- **State versioning / optimistic concurrency**: add `versionstamp` (KV) or
  `updated_at` check (Prisma) to detect concurrent writes across agents.
- **Observable state diffs**: emit a richer `StateChangeEvent` with
  `{ prev, next }` for the observability middleware to diff and trace.
- **Cross-agent shared state**: `app:` keys are already multi-agent; add a
  pub/sub hook so agents can react to app-scoped changes (broker broadcast).
