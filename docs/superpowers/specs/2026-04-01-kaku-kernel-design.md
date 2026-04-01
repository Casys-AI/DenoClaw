# Kaku Kernel — Agent Core Event-Driven Refactoring

Date: 2026-04-01
Status: design approved

## Summary

Refactor DenoClaw's agent execution from two duplicated while-loops
(`loop_process.ts` for local, `runtime_conversation.ts` for broker) into a
single event-emitting AsyncGenerator kernel with a composable middleware
pipeline. Working name: **Kaku** (核).

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Priority | Unify loops first | Solid foundation before adding features |
| Kernel model | Event-emitting AsyncGenerator | Unification + event model in one shot |
| Agent/runner boundary | Hybrid (yield intent, middleware auto-resolve) | Flexibility without forced complexity |
| Crash recovery | Design-for (EventStore contract, in-memory v1) | Pragmatic — plug real store later |
| Scope | Both runners (local + broker) in v1 | No period with two parallel systems |

## Architecture overview

```
┌─────────────────────────────────────────────────┐
│                  AgentRunner                     │
│  ┌───────────┐   ┌──────────────┐   ┌────────┐ │
│  │  Kernel    │──>│  Middleware   │──>│ Event  │ │
│  │ (generator)│<──│  Pipeline    │   │ Store  │ │
│  └───────────┘   └──────────────┘   └────────┘ │
└─────────────────────────────────────────────────┘
         │                 │
     yield events     resolve events
         │                 │
         ▼                 ▼
   AgentEvent        EventResolution
```

The kernel yields typed events. The middleware pipeline processes each event
(observe, transform, or resolve). The runner orchestrates the loop between
kernel and pipeline, persisting events via the EventStore.

## Events & types

### Base event

```typescript
interface BaseEvent {
  eventId: number
  timestamp: number
  iterationId: number
}
```

### Event types (discriminated union)

```typescript
type AgentEvent =
  | LlmRequestEvent      // kernel requests LLM call
  | LlmResponseEvent     // observation: LLM responded
  | ToolCallEvent         // kernel requests tool execution
  | ToolResultEvent       // observation: tool returned
  | ConfirmationRequestEvent // tool/agent requests external confirmation
  | StateChangeEvent      // session state mutation
  | DelegationEvent       // A2A delegation to another agent
  | CompleteEvent         // final answer
  | ErrorEvent            // recoverable or fatal error
```

### Resolution types

```typescript
type EventResolution =
  | LlmResolution        // LLM response (content + tool_calls?)
  | ToolResolution        // tool execution result
  | ConfirmationResolution // external confirmation response
  | DelegationResolution  // delegated agent response
```

### Semantics

- **Request events** (`llm_request`, `tool_call`, `confirmation_request`,
  `delegation`): the kernel captures the return value of `yield` as the
  resolution.
- **Observation events** (`llm_response`, `tool_result`, `state_change`):
  fire-and-forget, the kernel ignores the return value.
- All events are JSON-serializable for future EventStore persistence.
- `eventId` is sequential per conversation — basis for replay.

### Confirmation events (ADK-inspired)

`ConfirmationRequestEvent` generalizes the current privilege elevation /
INPUT_REQUIRED mechanism. Any tool or middleware can request external
confirmation — not just exec policy.

```typescript
interface ConfirmationRequestEvent extends BaseEvent {
  type: "confirmation_request"
  callId: string            // tool call that triggered this
  toolName: string          // which tool needs confirmation
  confirmationType: "boolean" | "structured"
  prompt: string            // human-readable explanation
  schema?: object           // expected response shape (structured mode)
  metadata?: Record<string, unknown>  // privilege scope, command, etc.
}

interface ConfirmationResolution {
  confirmed: boolean
  data?: Record<string, unknown>  // structured response (if applicable)
}
```

**Flow:**

1. Kernel yields `ToolCallEvent`
2. `toolMiddleware` detects tool requires confirmation
3. Middleware yields `ConfirmationRequestEvent` to runner
4. Runner persists event, forwards to client (channel, UI, API)
5. Runner **suspends** — generator stays paused
6. External response arrives (broker message, API call, etc.)
7. Runner injects `ConfirmationResolution` into generator
8. If confirmed → tool executes, kernel gets `ToolResolution`
9. If rejected → kernel gets error resolution, continues

This replaces the hard-coded privilege elevation in
`runtime_conversation.ts` with a generic, middleware-driven mechanism.
Any tool can use `require_confirmation: true` or a dynamic threshold
function (ADK pattern).

## Kernel (AsyncGenerator)

The kernel is a pure function encapsulating the ReAct loop. It knows nothing
about transport, storage, or concrete execution.

```typescript
async function* agentKernel(
  input: KernelInput
): AsyncGenerator<AgentEvent, CompleteEvent, EventResolution | undefined> {

  let iteration = 0
  let eventSeq = 0
  const event = (e) => ({
    ...e, eventId: eventSeq++, timestamp: Date.now(), iterationId: iteration,
  })

  while (iteration < input.maxIterations) {
    iteration++

    // 1. Request LLM — yield and await resolution
    const llmResolution = yield event({
      type: "llm_request",
      messages: input.getMessages(),
      tools: input.toolDefinitions,
      config: input.llmConfig,
    })

    // 2. Notify LLM response (observation)
    yield event({
      type: "llm_response",
      content: llmResolution.content,
      toolCalls: llmResolution.toolCalls,
      usage: llmResolution.usage,
    })

    // 3. Tool calls → yield each, await resolution
    if (llmResolution.toolCalls?.length) {
      for (const tc of llmResolution.toolCalls) {
        const toolResolution = yield event({
          type: "tool_call",
          callId: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })

        yield event({
          type: "tool_result",
          callId: tc.id,
          name: tc.function.name,
          result: toolResolution,
        })
      }
      continue
    }

    // 4. No tool calls → final answer
    return event({ type: "complete", content: llmResolution.content })
  }

  return event({
    type: "error",
    code: "max_iterations",
    recovery: "increase limit or simplify task",
  })
}
```

### KernelInput

```typescript
interface KernelInput {
  getMessages: () => Message[]    // callback — memory provides messages
  toolDefinitions: ToolDefinition[]
  llmConfig: AgentConfig
  maxIterations: number
  systemPrompt: string
}
```

### Properties

- No side effects — no persistence, no logging, no execution.
- `getMessages()` is a callback so the memory middleware can inject messages
  without the kernel storing them.
- The kernel is testable in isolation with mock resolutions.

## Middleware pipeline

### Middleware contract

```typescript
type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<EventResolution | void>
) => Promise<EventResolution | void>

interface MiddlewareContext {
  event: AgentEvent
  session: SessionState
  resolve(resolution: EventResolution): void
}
```

### Pipeline

```typescript
class MiddlewarePipeline {
  private stack: Middleware[] = []

  use(mw: Middleware): this {
    this.stack.push(mw)
    return this
  }

  async execute(
    event: AgentEvent,
    session: SessionState,
  ): Promise<EventResolution | void> {
    let index = 0
    const next = async (): Promise<EventResolution | void> => {
      if (index >= this.stack.length) return undefined
      const mw = this.stack[index++]
      return mw({ event, session, resolve: (r) => r }, next)
    }
    return next()
  }
}
```

### Middlewares (v1)

| Middleware | File | Resolves? | Purpose |
|---|---|---|---|
| `llmMiddleware` | `middlewares/llm.ts` | Yes — `llm_request` | Calls LLM via ProviderManager or AgentLlmToolPort |
| `toolMiddleware` | `middlewares/tool.ts` | Yes — `tool_call` | Executes tools via ToolRegistry or AgentLlmToolPort |
| `memoryMiddleware` | `middlewares/memory.ts` | No | Persists messages on `llm_response`, `tool_result` |
| `observabilityMiddleware` | `middlewares/observability.ts` | No | Creates tracing spans around events |
| `contextRefreshMiddleware` | `middlewares/context_refresh.ts` | No | Reloads skills/memory files after tool calls |
| `a2aTaskMiddleware` | `middlewares/a2a_task.ts` | Yes — `delegation` | A2A task lifecycle, privilege elevation |

### Local vs broker = different pipeline composition

```typescript
// Local
pipeline
  .use(observabilityMiddleware(tracer))
  .use(memoryMiddleware(memory))
  .use(contextRefreshMiddleware(skills, memoryFiles))
  .use(toolMiddleware(toolRegistry))
  .use(llmMiddleware(providerManager))

// Broker
pipeline
  .use(observabilityMiddleware(tracer))
  .use(memoryMiddleware(memory))
  .use(contextRefreshMiddleware(skills, memoryFiles))
  .use(a2aTaskMiddleware(taskState, reportFn))
  .use(toolMiddleware(agentPort))
  .use(llmMiddleware(agentPort))
```

No code duplication — only different middleware stacks.

## AgentRunner

```typescript
class AgentRunner {
  constructor(
    private pipeline: MiddlewarePipeline,
    private eventStore: EventStore,
    private session: SessionState,
  ) {}

  async run(input: KernelInput): Promise<AgentResult> {
    const kernel = agentKernel(input)
    let next = await kernel.next()

    while (!next.done) {
      const event = next.value

      // 1. Persist event (no-op in v1)
      await this.eventStore.commit(event)

      // 2. Pass through middleware pipeline
      const resolution = await this.pipeline.execute(event, this.session)

      // 3. Re-inject resolution into kernel
      next = await kernel.next(resolution)
    }

    await this.eventStore.commit(next.value)
    return toAgentResult(next.value)
  }
}
```

### EventStore (v1)

```typescript
interface EventStore {
  commit(event: AgentEvent): Promise<void>
  getEvents(conversationId: string): Promise<AgentEvent[]>
}

class InMemoryEventStore implements EventStore {
  private events: AgentEvent[] = []
  async commit(event: AgentEvent) { this.events.push(event) }
  async getEvents() { return this.events }
}
```

### Factory functions

```typescript
function createLocalRunner(deps: LocalDeps): AgentRunner {
  const pipeline = new MiddlewarePipeline()
    .use(observabilityMiddleware(deps.tracer))
    .use(memoryMiddleware(deps.memory))
    .use(contextRefreshMiddleware(deps.skills, deps.memoryFiles))
    .use(toolMiddleware(deps.toolRegistry))
    .use(llmMiddleware(deps.providerManager))
  return new AgentRunner(pipeline, new InMemoryEventStore(), deps.session)
}

function createBrokerRunner(deps: BrokerDeps): AgentRunner {
  const pipeline = new MiddlewarePipeline()
    .use(observabilityMiddleware(deps.tracer))
    .use(memoryMiddleware(deps.memory))
    .use(contextRefreshMiddleware(deps.skills, deps.memoryFiles))
    .use(a2aTaskMiddleware(deps.taskState, deps.reportFn))
    .use(toolMiddleware(deps.agentPort))
    .use(llmMiddleware(deps.agentPort))
  return new AgentRunner(pipeline, new InMemoryEventStore(), deps.session)
}
```

## Migration plan

### New files (`src/agent/`)

| File | Content |
|---|---|
| `events.ts` | All event + resolution types |
| `middleware.ts` | `Middleware` type + `MiddlewarePipeline` class |
| `kernel.ts` | `agentKernel()` generator + `KernelInput` |
| `runner.ts` | `AgentRunner` + factory functions |
| `event_store.ts` | `EventStore` interface + `InMemoryEventStore` |
| `middlewares/llm.ts` | LLM resolution middleware |
| `middlewares/tool.ts` | Tool execution middleware |
| `middlewares/memory.ts` | Message persistence middleware |
| `middlewares/observability.ts` | Tracing spans middleware |
| `middlewares/context_refresh.ts` | Skills/files reload middleware |
| `middlewares/a2a_task.ts` | A2A lifecycle middleware |

### Modified files

| File | Change |
|---|---|
| `loop.ts` (`AgentLoop`) | `processMessage()` delegates to `createLocalRunner().run()` |
| `runtime.ts` (`AgentRuntime`) | `executeAgentConversation()` delegates to `createBrokerRunner().run()` |
| `context.ts` | Expose `getMessages` as callback for `KernelInput` |

### Deleted files

| File | Reason |
|---|---|
| `loop_process.ts` | Absorbed by `kernel.ts` + middlewares |
| `runtime_conversation.ts` | Absorbed by `kernel.ts` + middlewares |
| `conversation_context_refresh.ts` | Absorbed by `middlewares/context_refresh.ts` |

### Unchanged

- `tools/`, `tools/backends/` — intact
- `worker_*.ts` — intact
- `workspace.ts`, `skills.ts` — intact
- `deploy_runtime.ts` — intact
- Broker, federation, channels, transport — intact

### Build sequence

1. Create `events.ts` — types first, zero dependencies
2. Create `middleware.ts` + `event_store.ts` — the framework
3. Create `kernel.ts` — generator, depends only on `events.ts`
4. Create the 6 middlewares — each testable in isolation
5. Create `runner.ts` — assembles everything
6. Wire `loop.ts` to `createLocalRunner` — test local path
7. Wire `runtime.ts` to `createBrokerRunner` — test broker path
8. Delete `loop_process.ts`, `runtime_conversation.ts`,
   `conversation_context_refresh.ts`
9. `deno task test` + `deno task test:e2e` — validate non-regression

### Estimates

~1200 lines new, ~800 lines deleted. Net: +400 lines, zero duplication,
extensible architecture ready for session state, Mastra memory, and workflow
agents in subsequent iterations.

## Future extensions (not in this iteration)

- **Session state with scoped prefixes** (`session:`, `user:`, `app:`,
  `temp:`) — new middleware + `SessionService` adapter
- **Mastra memory adapter** — `MemoryService` wrapping `@mastra/memory`
  behind the existing `MemoryPort`
- **Workflow agents** — sequential, parallel, loop primitives built on top of
  the kernel
- **Crash recovery** — swap `InMemoryEventStore` for a KV/Postgres-backed
  store, add replay logic in `AgentRunner`
- **JSR publication** — extract `kernel.ts`, `middleware.ts`, `runner.ts`,
  `events.ts` as `jsr:@denoclaw/kaku`
