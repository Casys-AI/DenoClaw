# Crash Recovery via Event Replay

Date: 2026-04-02
Status: design approved

## Summary

When an agent run is interrupted — process crash, network timeout, deploy
restart — the next invocation for the same conversation should replay already-
committed events and resume the kernel from the last uncommitted step, rather
than starting from scratch.

This spec designs:
- Persistent `EventStore` implementations (KV and Postgres-backed)
- Changes to `AgentRunner.run()` to support replay
- What "resume" means for the Kaku `AsyncGenerator` kernel
- Edge cases: partial tool execution, in-flight LLM calls

The `InMemoryEventStore` is v1 (already shipped). This is v2: make
`EventStore` durable without touching the kernel.

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Persistence granularity | One record per `AgentEvent` | Fine-grained replay; matches existing `EventStore.commit()` contract |
| Replay strategy | Re-run kernel, skip resolved events, re-inject stored resolutions | Kernel is a pure generator — replay is just re-driving it faster |
| Idempotency on resume | LLM calls are re-issued for in-flight events; tool calls are idempotent-or-skip | Simpler than storing intermediate LLM state; tools must declare idempotency |
| Committed vs. in-flight | Committed = response stored in EventStore; in-flight = no record | Unambiguous boundary; in-flight events are always re-executed |
| Store interface change | Add `conversationId` to `getEvents` (already implied); add `hasEvent(eventId)` | Needed for O(1) replay skip check |
| KV implementation | `DenoKvEventStore` with `["events", conversationId, eventId]` key space | Deno-native, zero deps |
| Postgres implementation | `PrismaEventStore` with `agent_events` table | For deploy parity with Prisma analytics and memory |
| Tool partial execution | Re-execute; tool implementations must be idempotent or declare `non_idempotent: true` | Push responsibility to the tool layer; simpler kernel |
| LLM in-flight | Re-issue the LLM call | LLM responses are not side effects; re-issuing is safe and cheap |
| `ConfirmationRequestEvent` in-flight | Re-suspend — same as initial run | External party re-delivers confirmation or times out |

## Architecture overview

```
On new invocation:
   │
   ├─ EventStore.getEvents(conversationId)
   │       └─ returns already-committed events (may be empty → fresh run)
   │
   ├─ AgentRunner.run(input, { replay: committedEvents })
   │       │
   │       ├─ Kernel starts fresh (agentKernel(input))
   │       ├─ Replay phase: for each event in committedEvents
   │       │     - kernel.next() → yields event
   │       │     - if event is a request type: re-inject stored resolution
   │       │     - if event is an observation: re-inject undefined (kernel ignores)
   │       │     - do NOT call pipeline or re-commit
   │       │
   │       └─ Live phase: kernel.next() → new event → pipeline → commit → re-inject
```

The kernel is identical in both phases. Replay just drives it faster with
pre-computed resolutions instead of calling the pipeline.

## Updated EventStore interface

```typescript
// src/agent/event_store.ts  (updated)

export interface EventStore {
  /** Persist a single event. */
  commit(event: AgentEvent): Promise<void>;

  /** Fetch all committed events for a conversation, ordered by eventId. */
  getEvents(conversationId: string): Promise<AgentEvent[]>;

  /** Check if an event with this id is already committed (for O(1) skip). */
  hasEvent(conversationId: string, eventId: number): Promise<boolean>;
}
```

The existing `InMemoryEventStore.getEvents()` had no `conversationId` parameter.
It is updated to accept (and ignore) it — no behaviour change for in-memory use.

## Stored resolution map

During replay, the runner builds a `Map<eventId, EventResolution>` from the
committed events by inferring resolutions:

```typescript
// src/agent/runner.ts  (new helper)

function buildReplayMap(events: AgentEvent[]): Map<number, EventResolution | undefined> {
  const map = new Map<number, EventResolution | undefined>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.type === "llm_request") {
      // The resolution is the next llm_response event's content
      const response = events.slice(i + 1).find((e) => e.type === "llm_response") as LlmResponseEvent | undefined;
      if (response) {
        map.set(ev.eventId, {
          type: "llm",
          content: response.content,
          toolCalls: response.toolCalls,
          usage: response.usage,
        } satisfies LlmResolution);
      }
    }

    if (ev.type === "tool_call") {
      // The resolution is the matching tool_result event
      const result = events.slice(i + 1).find(
        (e) => e.type === "tool_result" && e.callId === ev.callId,
      ) as ToolResultEvent | undefined;
      if (result) {
        map.set(ev.eventId, { type: "tool", result: result.result } satisfies ToolResolution);
      }
    }

    // observation events: kernel ignores resolution → map entry is undefined
  }

  return map;
}
```

## Updated AgentRunner.run()

```typescript
// src/agent/runner.ts  (updated)

interface RunOptions {
  conversationId?: string;
}

class AgentRunner {
  constructor(
    private pipeline: MiddlewarePipeline,
    private eventStore: EventStore,
    private session: SessionState,
    private memory: MemoryReader,
  ) {}

  async run(input: KernelInput, options: RunOptions = {}): Promise<AgentResponse> {
    const conversationId = options.conversationId ?? this.session.sessionId;

    // Load committed events for this conversation
    const committed = await this.eventStore.getEvents(conversationId);
    const replayMap = buildReplayMap(committed);
    const replayIds = new Set(committed.map((e) => e.eventId));

    const kernel = agentKernel(input);
    let next = await kernel.next();

    try {
      while (!next.done) {
        const event = next.value;

        if (replayIds.has(event.eventId)) {
          // REPLAY phase: skip pipeline and commit; re-inject stored resolution
          const resolution = replayMap.get(event.eventId);
          next = await kernel.next(resolution);
          continue;
        }

        // LIVE phase: normal execution
        await this.eventStore.commit(event);
        const resolution = await this.pipeline.execute(event, this.session);
        next = await kernel.next(resolution);
      }

      const finalEvent = next.value;
      if (!replayIds.has(finalEvent.eventId)) {
        await this.eventStore.commit(finalEvent);
        await this.pipeline.execute(finalEvent, this.session);
      }
      return await this.toAgentResult(finalEvent);
    } catch (e) {
      // ... existing error handling unchanged
      throw e;
    }
  }
}
```

The kernel's `eventId` counter starts at 0 on every call to `agentKernel()`.
This means a replayed run generates events with the same IDs as the original
run — which is the invariant that makes `replayIds.has(event.eventId)` work.

## Persistent EventStore implementations

### DenoKvEventStore

```typescript
// src/agent/adapters/event_store_kv.ts

class DenoKvEventStore implements EventStore {
  constructor(private kv: Deno.Kv) {}

  async commit(event: AgentEvent): Promise<void> {
    // Key: ["events", conversationId, eventId]
    // conversationId must be injected — we extend the commit signature below.
    throw new Error("Use commitFor(conversationId, event) instead");
  }

  async commitFor(conversationId: string, event: AgentEvent): Promise<void> {
    await this.kv.set(["events", conversationId, event.eventId], event);
  }

  async getEvents(conversationId: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const entry of this.kv.list<AgentEvent>({ prefix: ["events", conversationId] })) {
      events.push(entry.value);
    }
    return events.sort((a, b) => a.eventId - b.eventId);
  }

  async hasEvent(conversationId: string, eventId: number): Promise<boolean> {
    const entry = await this.kv.get(["events", conversationId, eventId]);
    return entry.value !== null;
  }
}
```

Note: `commit(event)` needs `conversationId` which is not in the current
`EventStore` interface. Two options:

1. **Preferred**: extend `EventStore.commit(event, conversationId)` — the
   `InMemoryEventStore` accepts and ignores it.
2. **Alternative**: close over `conversationId` in the constructor.

Option 1 is preferred for interface clarity (AX Principle 7: explicit over
implicit).

```typescript
// Updated interface
export interface EventStore {
  commit(event: AgentEvent, conversationId: string): Promise<void>;
  getEvents(conversationId: string): Promise<AgentEvent[]>;
  hasEvent(conversationId: string, eventId: number): Promise<boolean>;
}
```

### PrismaEventStore

```typescript
// src/agent/adapters/event_store_prisma.ts

// Schema: agent_events table
//   id             BIGSERIAL PRIMARY KEY
//   conversation_id TEXT NOT NULL
//   event_id        INT NOT NULL
//   event_type      TEXT NOT NULL
//   payload         JSONB NOT NULL
//   committed_at    TIMESTAMPTZ DEFAULT now()
//   UNIQUE(conversation_id, event_id)

class PrismaEventStore implements EventStore {
  constructor(private db: PrismaClient) {}

  async commit(event: AgentEvent, conversationId: string): Promise<void> {
    await this.db.agentEvent.upsert({
      where: { conversationId_eventId: { conversationId, eventId: event.eventId } },
      create: { conversationId, eventId: event.eventId, eventType: event.type, payload: event },
      update: {},  // idempotent: never overwrite
    });
  }

  async getEvents(conversationId: string): Promise<AgentEvent[]> {
    const rows = await this.db.agentEvent.findMany({
      where: { conversationId },
      orderBy: { eventId: "asc" },
    });
    return rows.map((r) => r.payload as AgentEvent);
  }

  async hasEvent(conversationId: string, eventId: number): Promise<boolean> {
    const count = await this.db.agentEvent.count({
      where: { conversationId, eventId },
    });
    return count > 0;
  }
}
```

## Edge cases

### Partial tool execution

If a crash occurs after the kernel yielded `tool_call` but before `tool_result`
was committed, the tool call has no stored resolution. On resume:

- `replayIds` does not contain the `tool_call` event's `eventId` (no committed
  entry).
- The runner enters the live phase and re-executes the tool call.
- Tools **must** be idempotent, or declare `non_idempotent: true` on their
  definition. Non-idempotent tools trigger a `ConfirmationRequestEvent` on
  re-execution.

```typescript
// In toolMiddleware, when re-executing a tool_call after resume:
if (toolDef.non_idempotent && session.isResume) {
  // Yield ConfirmationRequestEvent before proceeding
}
```

`session.isResume` is set by `AgentRunner.run()` when `committed.length > 0`.

### LLM calls mid-flight

A crash during an LLM call means no `llm_response` follows the `llm_request`
in the committed log. On resume, `buildReplayMap` finds no matching response —
`replayMap.get(llm_request.eventId)` is `undefined`. The runner enters the live
phase for that event and re-issues the LLM call.

LLM calls have no external side effects from the system's perspective — safe to
re-issue. Token cost is the only concern; acceptable trade-off for correctness.

### ConfirmationRequestEvent in-flight

A crash while awaiting external confirmation (agent suspended, waiting for
human approval) means the `confirmation_request` event was committed but no
`confirmation` resolution follows. On resume:

- The runner re-yields the `confirmation_request` to the pipeline.
- `a2aTaskMiddleware` re-suspends the run.
- The external party either re-delivers the confirmation or the request times
  out.

This is correct behaviour — no special case needed.

### Duplicate commit on crash mid-commit

`PrismaEventStore` uses `upsert` with `update: {}` (no-op if record exists).
`DenoKvEventStore` uses `kv.set` which is idempotent by key. Both stores are
safe to call twice for the same event.

### eventId collision across conversations

`eventId` is sequential per kernel invocation starting from 0. It is only
unique within a `(conversationId, run)` pair. The `EventStore` key space
always includes `conversationId` — no cross-conversation collision.

## Factory function update

```typescript
// src/agent/runner.ts

export function createLocalRunner(deps: LocalRunnerDeps): RunnerBundle {
  // ...existing logic...
  return {
    runner: new AgentRunner(
      pipeline,
      deps.eventStore ?? new InMemoryEventStore(),   // NEW: injectable
      session,
      deps.memory,
    ),
    session,
    kernelInput: { ... },
  };
}
```

`deps.eventStore` is optional — defaults to `InMemoryEventStore` so existing
callers are unaffected. Deploy configurations inject `DenoKvEventStore` or
`PrismaEventStore`.

## New / modified files

| File | Type | Change |
|---|---|---|
| `src/agent/event_store.ts` | Modified | Add `conversationId` param to `commit`; add `hasEvent`; update `InMemoryEventStore` |
| `src/agent/runner.ts` | Modified | Replay loop in `run()`; `RunOptions`; accept `eventStore?` in factory deps; `session.isResume` |
| `src/agent/adapters/event_store_kv.ts` | New | `DenoKvEventStore` |
| `src/agent/adapters/event_store_prisma.ts` | New | `PrismaEventStore` + Prisma schema delta |

## What does not change

- `agentKernel` — pure generator, zero changes. Replay is purely a runner
  concern.
- `MiddlewarePipeline` — skipped entirely during replay phase; no changes
  needed.
- All middlewares — replay skips them; live phase calls them normally.
- `SessionState` fields (except `isResume` flag, which is lightweight).
- Broker, federation, channels, transport — untouched.
- `WorkflowEventStore` (separate interface, separate concern; see workflow spec).

## Future extensions

- **Event TTL**: add `expires_at` to `PrismaEventStore` rows; prune old events
  via a cron job. `DenoKvEventStore` uses KV expiry option.
- **Event compaction**: after a successful run, replace the full event log with
  a single `CompactedRunEvent` containing only the final answer. Reduces replay
  cost for long conversations.
- **Selective replay skip**: skip re-loading events for conversations older
  than a threshold (configurable); treat as a fresh run.
- **Replay dry-run mode**: `run(input, { dryRun: true })` replays all committed
  events without entering live phase — useful for auditing and debugging.
- **Cross-agent event correlation**: add `parentConversationId` to the event
  store schema so A2A delegation chains can be traced end to end.
