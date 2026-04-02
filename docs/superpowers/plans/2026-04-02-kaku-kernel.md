# Kaku Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace two duplicated ReAct while-loops (`loop_process.ts` for local, `runtime_conversation.ts` for broker) with a single event-emitting AsyncGenerator kernel and composable middleware pipeline.

**Architecture:** The kernel is a pure AsyncGenerator that yields typed events (requests + observations). A Koa-style middleware pipeline resolves request events and observes observation events. An `AgentRunner` orchestrates the loop between kernel and pipeline. Local vs broker = different middleware stacks, zero code duplication.

**Tech Stack:** Deno, TypeScript (strict mode), AsyncGenerator, Deno.test

**Spec:** `docs/superpowers/specs/2026-04-01-kaku-kernel-design.md`

---

## File Structure

### New files (`src/agent/`)

| File | Responsibility |
|---|---|
| `events.ts` | All event types, resolution types, utility formatters |
| `middleware.ts` | `Middleware` type + `MiddlewarePipeline` class |
| `event_store.ts` | `EventStore` interface + `InMemoryEventStore` |
| `kernel.ts` | `agentKernel()` AsyncGenerator + `KernelInput` |
| `runner.ts` | `AgentRunner` + `createLocalRunner()` + `createBrokerRunner()` |
| `middlewares/llm.ts` | Resolves `llm_request` via ProviderManager or AgentLlmToolPort |
| `middlewares/tool.ts` | Resolves `tool_call` via ToolRegistry or AgentLlmToolPort |
| `middlewares/memory.ts` | Observes `llm_response` + `tool_result`, persists to MemoryPort |
| `middlewares/observability.ts` | TraceWriter spans + OTEL spans around requests |
| `middlewares/context_refresh.ts` | Detects skill/memory mutations, triggers reload |
| `middlewares/a2a_task.ts` | Broker-only: A2A task lifecycle, privilege elevation |

### Modified files

| File | Change |
|---|---|
| `loop.ts` | `processMessage()` delegates to `createLocalRunner().run()` |
| `runtime.ts` | `handleTaskSubmitMessage()` / `handleTaskContinueMessage()` delegate to `createBrokerRunner().run()` |
| `mod.ts` | Re-export new public types |

### Deleted files

| File | Reason |
|---|---|
| `loop_process.ts` | Absorbed by kernel + middlewares |
| `runtime_conversation.ts` | Absorbed by kernel + middlewares |
| `conversation_context_refresh.ts` | Absorbed by `middlewares/context_refresh.ts` |
| `runtime_conversation_test.ts` | Replaced by middleware + kernel tests |

---

## Task 1: Event types (`events.ts`)

**Files:**
- Create: `src/agent/events.ts`
- Test: `src/agent/events_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/events_test.ts
import { assertEquals } from "@std/assert";
import { createEventFactory, formatToolResultContent } from "./events.ts";
import type {
  CompleteEvent,
  ErrorEvent,
  LlmRequestEvent,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./events.ts";

Deno.test("createEventFactory produces sequential eventIds", () => {
  const event = createEventFactory();
  const e1 = event({ type: "llm_request", messages: [], tools: [], config: { model: "test" } }, 1);
  const e2 = event({ type: "llm_response", content: "hi", toolCalls: [] }, 1);
  assertEquals(e1.eventId, 0);
  assertEquals(e2.eventId, 1);
  assertEquals(typeof e1.timestamp, "number");
  assertEquals(e1.iterationId, 1);
});

Deno.test("formatToolResultContent formats success", () => {
  assertEquals(
    formatToolResultContent({ success: true, output: "done" }),
    "done",
  );
});

Deno.test("formatToolResultContent formats error", () => {
  const result = formatToolResultContent({
    success: false,
    output: "",
    error: { code: "FAIL", context: { key: "val" }, recovery: "retry" },
  });
  assertEquals(result, 'Error [FAIL]: {"key":"val"}\nRecovery: retry');
});

Deno.test("event types are discriminated by type field", () => {
  const event = createEventFactory();
  const llmReq: LlmRequestEvent = event(
    { type: "llm_request", messages: [], tools: [], config: { model: "m" } },
    1,
  );
  const llmRes: LlmResponseEvent = event(
    { type: "llm_response", content: "x", toolCalls: [] },
    1,
  );
  const toolCall: ToolCallEvent = event(
    { type: "tool_call", callId: "c1", name: "shell", arguments: {} },
    1,
  );
  const toolResult: ToolResultEvent = event(
    {
      type: "tool_result",
      callId: "c1",
      name: "shell",
      arguments: {},
      result: { success: true, output: "ok" },
    },
    1,
  );
  const complete: CompleteEvent = event(
    { type: "complete", content: "final" },
    1,
  );
  const error: ErrorEvent = event(
    { type: "error", code: "max_iterations", recovery: "try again" },
    1,
  );

  assertEquals(llmReq.type, "llm_request");
  assertEquals(llmRes.type, "llm_response");
  assertEquals(toolCall.type, "tool_call");
  assertEquals(toolResult.type, "tool_result");
  assertEquals(complete.type, "complete");
  assertEquals(error.type, "error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/events_test.ts`
Expected: FAIL — module `./events.ts` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/events.ts
import type {
  AgentConfig,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";

// ── Base ─────────────────────────────────────────────

interface BaseEvent {
  eventId: number;
  timestamp: number;
  iterationId: number;
}

// ── Request events (kernel yields, middleware resolves) ──

export interface LlmRequestEvent extends BaseEvent {
  type: "llm_request";
  messages: Message[];
  tools: ToolDefinition[];
  config: AgentConfig;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ConfirmationRequestEvent extends BaseEvent {
  type: "confirmation_request";
  callId: string;
  toolName: string;
  confirmationType: "boolean" | "structured";
  prompt: string;
  schema?: object;
  metadata?: Record<string, unknown>;
}

export interface DelegationEvent extends BaseEvent {
  type: "delegation";
  targetAgent: string;
  message: string;
}

// ── Observation events (fire-and-forget) ────────────

export interface LlmResponseEvent extends BaseEvent {
  type: "llm_response";
  content: string;
  toolCalls?: ToolCall[];
  usage?: LLMResponse["usage"];
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
}

export interface StateChangeEvent extends BaseEvent {
  type: "state_change";
  key: string;
  value: unknown;
}

// ── Terminal events (generator return) ──────────────

export interface CompleteEvent extends BaseEvent {
  type: "complete";
  content: string;
  finishReason?: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  code: string;
  recovery?: string;
}

// ── Unions ───────────────────────────────────────────

export type AgentEvent =
  | LlmRequestEvent
  | LlmResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | ConfirmationRequestEvent
  | StateChangeEvent
  | DelegationEvent
  | CompleteEvent
  | ErrorEvent;

export type FinalEvent = CompleteEvent | ErrorEvent;

// ── Resolution types ────────────────────────────────

export interface LlmResolution {
  type: "llm";
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: LLMResponse["usage"];
}

export interface ToolResolution {
  type: "tool";
  result: ToolResult;
}

export interface ConfirmationResolution {
  type: "confirmation";
  confirmed: boolean;
  data?: Record<string, unknown>;
}

export interface DelegationResolution {
  type: "delegation";
  result: string;
}

export type EventResolution =
  | LlmResolution
  | ToolResolution
  | ConfirmationResolution
  | DelegationResolution;

// ── Factory ─────────────────────────────────────────

type EventBody<E extends AgentEvent> = Omit<
  E,
  "eventId" | "timestamp" | "iterationId"
>;

export function createEventFactory(): <E extends AgentEvent>(
  body: EventBody<E>,
  iterationId: number,
) => E {
  let seq = 0;
  return <E extends AgentEvent>(
    body: EventBody<E>,
    iterationId: number,
  ): E => {
    return {
      ...body,
      eventId: seq++,
      timestamp: Date.now(),
      iterationId,
    } as E;
  };
}

// ── Utility ─────────────────────────────────────────

export function formatToolResultContent(result: ToolResult): string {
  if (result.success) return result.output;
  return `Error [${result.error?.code}]: ${
    JSON.stringify(result.error?.context)
  }\nRecovery: ${result.error?.recovery ?? "none"}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/events_test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/events.ts src/agent/events_test.ts
git commit -m "feat(kaku): add event and resolution types"
```

---

## Task 2: Middleware pipeline (`middleware.ts`)

**Files:**
- Create: `src/agent/middleware.ts`
- Test: `src/agent/middleware_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middleware_test.ts
import { assertEquals } from "@std/assert";
import { MiddlewarePipeline } from "./middleware.ts";
import type { Middleware, SessionState } from "./middleware.ts";
import type { LlmRequestEvent } from "./events.ts";

function makeEvent(): LlmRequestEvent {
  return {
    eventId: 0,
    timestamp: Date.now(),
    iterationId: 1,
    type: "llm_request",
    messages: [],
    tools: [],
    config: { model: "test" },
  };
}

function makeSession(): SessionState {
  return {
    agentId: "agent-1",
    sessionId: "sess-1",
    memoryTopics: [],
    memoryFiles: [],
    currentIteration: 0,
  };
}

Deno.test("empty pipeline returns undefined", async () => {
  const pipeline = new MiddlewarePipeline();
  const result = await pipeline.execute(makeEvent(), makeSession());
  assertEquals(result, undefined);
});

Deno.test("middleware can resolve an event", async () => {
  const pipeline = new MiddlewarePipeline();
  pipeline.use(async (_ctx, _next) => {
    return { type: "llm" as const, content: "hello", toolCalls: [] };
  });
  const result = await pipeline.execute(makeEvent(), makeSession());
  assertEquals(result?.type, "llm");
});

Deno.test("middleware chain executes in order (onion model)", async () => {
  const order: string[] = [];
  const pipeline = new MiddlewarePipeline();

  pipeline.use(async (_ctx, next) => {
    order.push("A-before");
    const res = await next();
    order.push("A-after");
    return res;
  });
  pipeline.use(async (_ctx, next) => {
    order.push("B-before");
    const res = await next();
    order.push("B-after");
    return res;
  });
  pipeline.use(async (_ctx, _next) => {
    order.push("C-resolve");
    return { type: "llm" as const, content: "ok", toolCalls: [] };
  });

  await pipeline.execute(makeEvent(), makeSession());
  assertEquals(order, ["A-before", "B-before", "C-resolve", "B-after", "A-after"]);
});

Deno.test("middleware receives event and session in context", async () => {
  const pipeline = new MiddlewarePipeline();
  let capturedEvent: unknown;
  let capturedSession: unknown;

  pipeline.use(async (ctx, _next) => {
    capturedEvent = ctx.event;
    capturedSession = ctx.session;
    return undefined;
  });

  const event = makeEvent();
  const session = makeSession();
  await pipeline.execute(event, session);

  assertEquals(capturedEvent, event);
  assertEquals(capturedSession, session);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middleware_test.ts`
Expected: FAIL — module `./middleware.ts` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middleware.ts
import type { AgentEvent, EventResolution } from "./events.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";
import type { Task } from "../messaging/a2a/types.ts";

// ── Session state (shared mutable state across middlewares) ──

export interface SessionState {
  agentId: string;
  sessionId: string;
  memoryTopics: string[];
  memoryFiles: string[];
  currentIteration: number;
  // Trace (local only)
  traceId?: string;
  currentIterationSpanId?: string;
  // Broker (optional)
  canonicalTask?: Task;
  runtimeGrants?: AgentRuntimeGrant[];
}

// ── Middleware contract ──

export interface MiddlewareContext {
  event: AgentEvent;
  session: SessionState;
}

export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<EventResolution | undefined>,
) => Promise<EventResolution | undefined>;

// ── Pipeline ──

export class MiddlewarePipeline {
  private stack: Middleware[] = [];

  use(mw: Middleware): this {
    this.stack.push(mw);
    return this;
  }

  async execute(
    event: AgentEvent,
    session: SessionState,
  ): Promise<EventResolution | undefined> {
    let index = 0;
    const next = async (): Promise<EventResolution | undefined> => {
      if (index >= this.stack.length) return undefined;
      const mw = this.stack[index++];
      return mw({ event, session }, next);
    };
    return next();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middleware_test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middleware.ts src/agent/middleware_test.ts
git commit -m "feat(kaku): add Middleware type and MiddlewarePipeline"
```

---

## Task 3: Event store (`event_store.ts`)

**Files:**
- Create: `src/agent/event_store.ts`
- Test: `src/agent/event_store_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/event_store_test.ts
import { assertEquals } from "@std/assert";
import { InMemoryEventStore } from "./event_store.ts";
import type { CompleteEvent, LlmRequestEvent } from "./events.ts";

Deno.test("InMemoryEventStore stores and retrieves events", async () => {
  const store = new InMemoryEventStore();

  const e1: LlmRequestEvent = {
    eventId: 0,
    timestamp: Date.now(),
    iterationId: 1,
    type: "llm_request",
    messages: [],
    tools: [],
    config: { model: "test" },
  };
  const e2: CompleteEvent = {
    eventId: 1,
    timestamp: Date.now(),
    iterationId: 1,
    type: "complete",
    content: "done",
  };

  await store.commit(e1);
  await store.commit(e2);

  const events = await store.getEvents();
  assertEquals(events.length, 2);
  assertEquals(events[0].type, "llm_request");
  assertEquals(events[1].type, "complete");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/event_store_test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/event_store.ts
import type { AgentEvent } from "./events.ts";

export interface EventStore {
  commit(event: AgentEvent): Promise<void>;
  getEvents(): Promise<AgentEvent[]>;
}

export class InMemoryEventStore implements EventStore {
  private events: AgentEvent[] = [];

  async commit(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }

  async getEvents(): Promise<AgentEvent[]> {
    return [...this.events];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/event_store_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/event_store.ts src/agent/event_store_test.ts
git commit -m "feat(kaku): add EventStore interface and InMemoryEventStore"
```

---

## Task 4: Kernel (`kernel.ts`)

The kernel is the core AsyncGenerator. It yields events and receives resolutions. It has zero side effects.

**Files:**
- Create: `src/agent/kernel.ts`
- Test: `src/agent/kernel_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/kernel_test.ts
import { assertEquals } from "@std/assert";
import { agentKernel } from "./kernel.ts";
import type { KernelInput } from "./kernel.ts";
import type {
  EventResolution,
  LlmRequestEvent,
  LlmResolution,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResolution,
  ToolResultEvent,
} from "./events.ts";

function makeInput(overrides?: Partial<KernelInput>): KernelInput {
  return {
    getMessages: () => [{ role: "user", content: "hello" }],
    toolDefinitions: [],
    llmConfig: { model: "test/model" },
    maxIterations: 5,
    ...overrides,
  };
}

Deno.test("kernel yields llm_request then completes on text-only response", async () => {
  const kernel = agentKernel(makeInput());

  // 1. First yield: llm_request
  const step1 = await kernel.next();
  assertEquals(step1.done, false);
  const llmReq = step1.value as LlmRequestEvent;
  assertEquals(llmReq.type, "llm_request");
  assertEquals(llmReq.iterationId, 1);

  // Inject LLM resolution (no tool calls)
  const llmResolution: LlmResolution = {
    type: "llm",
    content: "Hello back!",
    finishReason: "stop",
  };
  const step2 = await kernel.next(llmResolution);
  assertEquals(step2.done, false);

  // 2. Second yield: llm_response (observation)
  const llmRes = step2.value as LlmResponseEvent;
  assertEquals(llmRes.type, "llm_response");
  assertEquals(llmRes.content, "Hello back!");

  // Pass undefined (observation — return value ignored)
  const step3 = await kernel.next(undefined);

  // 3. Generator completes with CompleteEvent
  assertEquals(step3.done, true);
  assertEquals(step3.value.type, "complete");
  assertEquals(step3.value.content, "Hello back!");
});

Deno.test("kernel handles tool calls", async () => {
  const kernel = agentKernel(makeInput());

  // 1. llm_request
  const step1 = await kernel.next();
  assertEquals(step1.done, false);

  // Inject LLM resolution WITH tool calls
  const llmRes: LlmResolution = {
    type: "llm",
    content: "",
    toolCalls: [
      {
        id: "tc1",
        type: "function",
        function: { name: "shell", arguments: '{"command":"ls"}' },
      },
    ],
  };
  const step2 = await kernel.next(llmRes);
  // llm_response observation
  assertEquals(step2.done, false);
  assertEquals((step2.value as LlmResponseEvent).type, "llm_response");

  // Pass undefined for observation
  const step3 = await kernel.next(undefined);
  assertEquals(step3.done, false);

  // tool_call request
  const toolCall = step3.value as ToolCallEvent;
  assertEquals(toolCall.type, "tool_call");
  assertEquals(toolCall.name, "shell");
  assertEquals(toolCall.arguments, { command: "ls" });

  // Inject tool resolution
  const toolRes: ToolResolution = {
    type: "tool",
    result: { success: true, output: "file.txt" },
  };
  const step4 = await kernel.next(toolRes);
  assertEquals(step4.done, false);

  // tool_result observation
  const toolResult = step4.value as ToolResultEvent;
  assertEquals(toolResult.type, "tool_result");
  assertEquals(toolResult.result.output, "file.txt");

  // Pass undefined for observation → kernel loops to next iteration (llm_request)
  const step5 = await kernel.next(undefined);
  assertEquals(step5.done, false);
  assertEquals((step5.value as LlmRequestEvent).type, "llm_request");
});

Deno.test("kernel handles invalid JSON tool arguments gracefully", async () => {
  const kernel = agentKernel(makeInput());

  const step1 = await kernel.next();
  assertEquals(step1.done, false);

  // LLM returns tool call with invalid JSON
  const llmRes: LlmResolution = {
    type: "llm",
    content: "",
    toolCalls: [
      {
        id: "tc-bad",
        type: "function",
        function: { name: "shell", arguments: "{invalid json" },
      },
    ],
  };
  const step2 = await kernel.next(llmRes);
  // llm_response
  assertEquals(step2.done, false);

  const step3 = await kernel.next(undefined);
  // tool_result with error (no tool_call yield for invalid JSON)
  assertEquals(step3.done, false);
  const result = step3.value as ToolResultEvent;
  assertEquals(result.type, "tool_result");
  assertEquals(result.result.success, false);
  assertEquals(result.result.error?.code, "INVALID_JSON");
});

Deno.test("kernel returns error on max iterations", async () => {
  const kernel = agentKernel(makeInput({ maxIterations: 1 }));

  // Iteration 1: llm_request
  await kernel.next();

  // LLM returns tool calls (forces continuation)
  const step2 = await kernel.next({
    type: "llm",
    content: "",
    toolCalls: [
      {
        id: "tc1",
        type: "function",
        function: { name: "shell", arguments: '{"command":"ls"}' },
      },
    ],
  } as LlmResolution);
  await kernel.next(undefined); // llm_response observation

  // tool_call
  const step4 = await kernel.next({ type: "tool", result: { success: true, output: "ok" } } as ToolResolution);
  await kernel.next(undefined); // tool_result observation

  // Max iterations reached — generator returns error
  const final = await kernel.next(undefined);
  assertEquals(final.done, true);
  assertEquals(final.value.type, "error");
  assertEquals((final.value as { code: string }).code, "max_iterations");
});

Deno.test("kernel eventIds are sequential", async () => {
  const kernel = agentKernel(makeInput());

  const step1 = await kernel.next();
  assertEquals((step1.value as LlmRequestEvent).eventId, 0);

  const step2 = await kernel.next({
    type: "llm",
    content: "done",
  } as LlmResolution);
  assertEquals((step2.value as LlmResponseEvent).eventId, 1);

  const step3 = await kernel.next(undefined);
  assertEquals(step3.value.eventId, 2); // CompleteEvent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/kernel_test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/kernel.ts
import type { Message, ToolDefinition } from "../shared/types.ts";
import type { AgentConfig } from "./types.ts";
import type {
  AgentEvent,
  CompleteEvent,
  ErrorEvent,
  EventResolution,
  FinalEvent,
  LlmResolution,
  ToolResolution,
} from "./events.ts";
import { createEventFactory } from "./events.ts";

export interface KernelInput {
  getMessages: () => Message[];
  toolDefinitions: ToolDefinition[];
  llmConfig: AgentConfig;
  maxIterations: number;
}

export async function* agentKernel(
  input: KernelInput,
): AsyncGenerator<AgentEvent, FinalEvent, EventResolution | undefined> {
  const event = createEventFactory();
  let iteration = 0;

  while (iteration < input.maxIterations) {
    iteration++;

    // 1. Request LLM call
    const llmResolution = (yield event<AgentEvent>(
      {
        type: "llm_request",
        messages: input.getMessages(),
        tools: input.toolDefinitions,
        config: input.llmConfig,
      },
      iteration,
    )) as LlmResolution;

    // 2. Observe LLM response
    yield event<AgentEvent>(
      {
        type: "llm_response",
        content: llmResolution.content,
        toolCalls: llmResolution.toolCalls,
        usage: llmResolution.usage,
      },
      iteration,
    );

    // 3. Tool calls
    if (llmResolution.toolCalls?.length) {
      for (const tc of llmResolution.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          // Invalid JSON — yield error tool_result and skip
          yield event<AgentEvent>(
            {
              type: "tool_result",
              callId: tc.id,
              name: tc.function.name,
              arguments: {},
              result: {
                success: false,
                output: `Invalid JSON arguments for ${tc.function.name}`,
                error: {
                  code: "INVALID_JSON",
                  context: { tool: tc.function.name },
                  recovery: "Fix the JSON arguments",
                },
              },
            },
            iteration,
          );
          continue;
        }

        // Request tool execution
        const toolResolution = (yield event<AgentEvent>(
          {
            type: "tool_call",
            callId: tc.id,
            name: tc.function.name,
            arguments: args,
          },
          iteration,
        )) as ToolResolution;

        // Observe tool result
        yield event<AgentEvent>(
          {
            type: "tool_result",
            callId: tc.id,
            name: tc.function.name,
            arguments: args,
            result: toolResolution.result,
          },
          iteration,
        );
      }
      continue; // Next iteration
    }

    // 4. No tool calls — final answer
    return event<CompleteEvent>(
      { type: "complete", content: llmResolution.content, finishReason: llmResolution.finishReason },
      iteration,
    );
  }

  // Max iterations reached
  return event<ErrorEvent>(
    {
      type: "error",
      code: "max_iterations",
      recovery: "increase limit or simplify task",
    },
    iteration,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/kernel_test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/kernel.ts src/agent/kernel_test.ts
git commit -m "feat(kaku): add agentKernel AsyncGenerator"
```

---

## Task 5: LLM middleware (`middlewares/llm.ts`)

**Files:**
- Create: `src/agent/middlewares/llm.ts`
- Test: `src/agent/middlewares/llm_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middlewares/llm_test.ts
import { assertEquals } from "@std/assert";
import { llmMiddleware } from "./llm.ts";
import type { LlmRequestEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";

function makeSession(): SessionState {
  return {
    agentId: "a", sessionId: "s", memoryTopics: [], memoryFiles: [],
    currentIteration: 0,
  };
}

Deno.test("llmMiddleware resolves llm_request events", async () => {
  const completeFn = (
    _messages: unknown[],
    _model: string,
  ) =>
    Promise.resolve({
      content: "response",
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

  const mw = llmMiddleware(completeFn);
  const event: LlmRequestEvent = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    config: { model: "test/m" },
  };

  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(undefined),
  );

  assertEquals(result?.type, "llm");
  if (result?.type === "llm") {
    assertEquals(result.content, "response");
  }
});

Deno.test("llmMiddleware passes through non-llm_request events", async () => {
  const completeFn = () => {
    throw new Error("should not be called");
  };

  const mw = llmMiddleware(completeFn);
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "tool_call" as const,
    callId: "c1", name: "shell", arguments: {},
  };

  const nextResult = { type: "tool" as const, result: { success: true, output: "ok" } };
  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(nextResult),
  );

  assertEquals(result, nextResult);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middlewares/llm_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middlewares/llm.ts
import type { LLMResponse, Message, ToolDefinition } from "../../shared/types.ts";
import type { AgentConfig } from "../types.ts";
import type { LlmRequestEvent, LlmResolution } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export type CompleteFn = (
  messages: Message[],
  model: string,
  temperature?: number,
  maxTokens?: number,
  tools?: ToolDefinition[],
) => Promise<LLMResponse>;

export function llmMiddleware(complete: CompleteFn): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== "llm_request") return next();

    const req = ctx.event as LlmRequestEvent;
    const response = await complete(
      req.messages,
      req.config.model,
      req.config.temperature,
      req.config.maxTokens,
      req.tools,
    );

    const resolution: LlmResolution = {
      type: "llm",
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      usage: response.usage,
    };
    return resolution;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middlewares/llm_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middlewares/llm.ts src/agent/middlewares/llm_test.ts
git commit -m "feat(kaku): add llmMiddleware"
```

---

## Task 6: Tool middleware (`middlewares/tool.ts`)

**Files:**
- Create: `src/agent/middlewares/tool.ts`
- Test: `src/agent/middlewares/tool_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middlewares/tool_test.ts
import { assertEquals } from "@std/assert";
import { toolMiddleware } from "./tool.ts";
import type { ToolCallEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";
import type { ToolResult } from "../../shared/types.ts";

function makeSession(): SessionState {
  return {
    agentId: "a", sessionId: "s", memoryTopics: [], memoryFiles: [],
    currentIteration: 0,
  };
}

Deno.test("toolMiddleware resolves tool_call events", async () => {
  const executeFn = (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    assertEquals(name, "shell");
    assertEquals(args, { command: "ls" });
    return Promise.resolve({ success: true, output: "file.txt" });
  };

  const mw = toolMiddleware(executeFn);
  const event: ToolCallEvent = {
    eventId: 2, timestamp: Date.now(), iterationId: 1,
    type: "tool_call",
    callId: "tc1",
    name: "shell",
    arguments: { command: "ls" },
  };

  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(undefined),
  );

  assertEquals(result?.type, "tool");
  if (result?.type === "tool") {
    assertEquals(result.result.output, "file.txt");
  }
});

Deno.test("toolMiddleware passes through non-tool_call events", async () => {
  const executeFn = () => {
    throw new Error("should not be called");
  };
  const mw = toolMiddleware(executeFn);
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request" as const,
    messages: [], tools: [], config: { model: "m" },
  };

  const nextResult = { type: "llm" as const, content: "ok" };
  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(nextResult),
  );
  assertEquals(result, nextResult);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middlewares/tool_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middlewares/tool.ts
import type { ToolResult } from "../../shared/types.ts";
import type { ToolCallEvent, ToolResolution } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export type ExecuteToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export function toolMiddleware(executeTool: ExecuteToolFn): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== "tool_call") return next();

    const req = ctx.event as ToolCallEvent;
    const result = await executeTool(req.name, req.arguments);

    const resolution: ToolResolution = { type: "tool", result };
    return resolution;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middlewares/tool_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middlewares/tool.ts src/agent/middlewares/tool_test.ts
git commit -m "feat(kaku): add toolMiddleware"
```

---

## Task 7: Memory middleware (`middlewares/memory.ts`)

**Files:**
- Create: `src/agent/middlewares/memory.ts`
- Test: `src/agent/middlewares/memory_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middlewares/memory_test.ts
import { assertEquals } from "@std/assert";
import { memoryMiddleware } from "./memory.ts";
import type { LlmResponseEvent, ToolResultEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";
import type { Message } from "../../shared/types.ts";

function makeSession(): SessionState {
  return {
    agentId: "a", sessionId: "s", memoryTopics: [], memoryFiles: [],
    currentIteration: 0,
  };
}

Deno.test("memoryMiddleware persists assistant message on llm_response with tool calls", async () => {
  const messages: Message[] = [];
  const memory = {
    addMessage: (msg: Message) => {
      messages.push(msg);
      return Promise.resolve();
    },
  };

  const mw = memoryMiddleware(memory);
  const event: LlmResponseEvent = {
    eventId: 1, timestamp: Date.now(), iterationId: 1,
    type: "llm_response",
    content: "thinking...",
    toolCalls: [
      { id: "tc1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
    ],
  };

  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));

  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "assistant");
  assertEquals(messages[0].content, "thinking...");
  assertEquals(messages[0].tool_calls?.length, 1);
});

Deno.test("memoryMiddleware persists assistant message on llm_response without tool calls", async () => {
  const messages: Message[] = [];
  const memory = {
    addMessage: (msg: Message) => {
      messages.push(msg);
      return Promise.resolve();
    },
  };

  const mw = memoryMiddleware(memory);
  const event: LlmResponseEvent = {
    eventId: 1, timestamp: Date.now(), iterationId: 1,
    type: "llm_response",
    content: "final answer",
  };

  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));

  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "assistant");
  assertEquals(messages[0].content, "final answer");
  assertEquals(messages[0].tool_calls, undefined);
});

Deno.test("memoryMiddleware persists tool result on tool_result", async () => {
  const messages: Message[] = [];
  const memory = {
    addMessage: (msg: Message) => {
      messages.push(msg);
      return Promise.resolve();
    },
  };

  const mw = memoryMiddleware(memory);
  const event: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result",
    callId: "tc1",
    name: "shell",
    arguments: { command: "ls" },
    result: { success: true, output: "file.txt" },
  };

  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));

  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "tool");
  assertEquals(messages[0].content, "file.txt");
  assertEquals(messages[0].name, "shell");
  assertEquals(messages[0].tool_call_id, "tc1");
});

Deno.test("memoryMiddleware formats error tool results", async () => {
  const messages: Message[] = [];
  const memory = {
    addMessage: (msg: Message) => {
      messages.push(msg);
      return Promise.resolve();
    },
  };

  const mw = memoryMiddleware(memory);
  const event: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result",
    callId: "tc1",
    name: "shell",
    arguments: {},
    result: {
      success: false,
      output: "",
      error: { code: "DENIED", context: { reason: "policy" }, recovery: "check perms" },
    },
  };

  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));

  assertEquals(messages[0].content, 'Error [DENIED]: {"reason":"policy"}\nRecovery: check perms');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middlewares/memory_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middlewares/memory.ts
import type { Message } from "../../shared/types.ts";
import type {
  LlmResponseEvent,
  ToolResultEvent,
} from "../events.ts";
import { formatToolResultContent } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export interface MemoryWriter {
  addMessage(message: Message): Promise<void>;
}

export function memoryMiddleware(memory: MemoryWriter): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      if (e.toolCalls?.length) {
        await memory.addMessage({
          role: "assistant",
          content: e.content || "",
          tool_calls: e.toolCalls,
        });
      } else {
        await memory.addMessage({
          role: "assistant",
          content: e.content,
        });
      }
    }

    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      await memory.addMessage({
        role: "tool",
        content: formatToolResultContent(e.result),
        name: e.name,
        tool_call_id: e.callId,
      });
    }

    return next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middlewares/memory_test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middlewares/memory.ts src/agent/middlewares/memory_test.ts
git commit -m "feat(kaku): add memoryMiddleware"
```

---

## Task 8: Observability middleware (`middlewares/observability.ts`)

**Files:**
- Create: `src/agent/middlewares/observability.ts`
- Test: `src/agent/middlewares/observability_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middlewares/observability_test.ts
import { assertEquals } from "@std/assert";
import { observabilityMiddleware } from "./observability.ts";
import type { SessionState } from "../middleware.ts";
import type { TraceCorrelationIds } from "../../telemetry/traces.ts";

class RecordingTraceWriter {
  calls: Array<{ method: string; args: unknown[] }> = [];
  traceStarted = false;

  startTrace(
    agentId: string,
    sessionId: string,
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    this.calls.push({ method: "startTrace", args: [agentId, sessionId, ids] });
    this.traceStarted = true;
    return Promise.resolve("trace-1");
  }

  endTrace(
    traceId: string,
    status: string,
    iterations: number,
  ): Promise<void> {
    this.calls.push({
      method: "endTrace",
      args: [traceId, status, iterations],
    });
    return Promise.resolve();
  }

  writeIterationSpan(
    traceId: string,
    agentId: string,
    iteration: number,
  ): Promise<string> {
    this.calls.push({
      method: "writeIterationSpan",
      args: [traceId, agentId, iteration],
    });
    return Promise.resolve(`iter-${iteration}`);
  }

  writeLLMSpan(
    traceId: string,
    _agentId: string,
    _parentSpanId: string,
    model: string,
  ): Promise<string> {
    this.calls.push({ method: "writeLLMSpan", args: [traceId, model] });
    return Promise.resolve("llm-span");
  }

  writeToolSpan(
    traceId: string,
    _agentId: string,
    _parentSpanId: string,
    tool: string,
    success: boolean,
  ): Promise<string> {
    this.calls.push({
      method: "writeToolSpan",
      args: [traceId, tool, success],
    });
    return Promise.resolve("tool-span");
  }

  endSpan(): Promise<void> {
    return Promise.resolve();
  }
}

function makeSession(): SessionState {
  return {
    agentId: "agent-1",
    sessionId: "sess-1",
    memoryTopics: [],
    memoryFiles: [],
    currentIteration: 0,
  };
}

Deno.test("observabilityMiddleware starts trace on first event", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never,
    agentId: "agent-1",
    sessionId: "sess-1",
    correlationIds: {},
  });

  const event = {
    eventId: 0,
    timestamp: Date.now(),
    iterationId: 1,
    type: "llm_request" as const,
    messages: [],
    tools: [],
    config: { model: "test/m" },
  };

  const resolution = {
    type: "llm" as const,
    content: "ok",
  };

  await mw(
    { event, session: makeSession() },
    () => Promise.resolve(resolution),
  );

  assertEquals(writer.traceStarted, true);
  const startCall = writer.calls.find((c) => c.method === "startTrace");
  assertEquals(startCall?.args[0], "agent-1");
});

Deno.test("observabilityMiddleware writes LLM span on llm_response", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never,
    agentId: "agent-1",
    sessionId: "sess-1",
    correlationIds: {},
  });

  // First: trigger trace start with llm_request
  await mw(
    {
      event: {
        eventId: 0, timestamp: Date.now(), iterationId: 1,
        type: "llm_request",
        messages: [], tools: [], config: { model: "test/m" },
      },
      session: makeSession(),
    },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );

  // Then: llm_response observation
  const session = makeSession();
  await mw(
    {
      event: {
        eventId: 1, timestamp: Date.now(), iterationId: 1,
        type: "llm_response",
        content: "hello",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      session,
    },
    () => Promise.resolve(undefined),
  );

  const llmCall = writer.calls.find((c) => c.method === "writeLLMSpan");
  assertEquals(llmCall !== undefined, true);
});

Deno.test("observabilityMiddleware ends trace on complete event", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never,
    agentId: "agent-1",
    sessionId: "sess-1",
    correlationIds: {},
  });

  const session = makeSession();

  // Start trace
  await mw(
    {
      event: {
        eventId: 0, timestamp: Date.now(), iterationId: 1,
        type: "llm_request",
        messages: [], tools: [], config: { model: "m" },
      },
      session,
    },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );

  // Complete
  await mw(
    {
      event: {
        eventId: 2, timestamp: Date.now(), iterationId: 1,
        type: "complete",
        content: "done",
      },
      session,
    },
    () => Promise.resolve(undefined),
  );

  const endCall = writer.calls.find((c) => c.method === "endTrace");
  assertEquals(endCall !== undefined, true);
  assertEquals(endCall?.args[1], "completed");
});

Deno.test("observabilityMiddleware works without traceWriter (no-op)", async () => {
  const mw = observabilityMiddleware({
    traceWriter: null,
    agentId: "a",
    sessionId: "s",
    correlationIds: {},
  });

  const result = await mw(
    {
      event: {
        eventId: 0, timestamp: Date.now(), iterationId: 1,
        type: "llm_request",
        messages: [], tools: [], config: { model: "m" },
      },
      session: makeSession(),
    },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );

  assertEquals(result?.type, "llm");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middlewares/observability_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middlewares/observability.ts
import type { TraceCorrelationIds, TraceWriter } from "../../telemetry/traces.ts";
import { spanAgentLoop, spanToolCall } from "../../telemetry/mod.ts";
import type {
  LlmRequestEvent,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../events.ts";
import type { Middleware } from "../middleware.ts";

export interface ObservabilityDeps {
  traceWriter: TraceWriter | null;
  agentId: string;
  sessionId: string;
  correlationIds: TraceCorrelationIds;
}

export function observabilityMiddleware(deps: ObservabilityDeps): Middleware {
  const { traceWriter, agentId, sessionId, correlationIds } = deps;
  let traceId: string | undefined;
  let currentIteration = 0;
  let iterSpanId: string | undefined;
  let iterStart = 0;
  let llmStart = 0;
  let lastModel = "";

  return async (ctx, next) => {
    // Initialize trace on first event
    if (!traceId && traceWriter) {
      traceId = await traceWriter.startTrace(
        agentId,
        sessionId,
        correlationIds,
      );
    }

    // New iteration — manage iteration spans
    if (ctx.event.iterationId > currentIteration) {
      if (iterSpanId && traceWriter && traceId) {
        await traceWriter.endSpan(
          traceId,
          iterSpanId,
          performance.now() - iterStart,
        );
      }
      currentIteration = ctx.event.iterationId;
      iterStart = performance.now();
      if (traceWriter && traceId) {
        iterSpanId = await traceWriter.writeIterationSpan(
          traceId,
          agentId,
          currentIteration,
          undefined,
          correlationIds,
        );
      }
    }

    // LLM request — wrap in OTEL span, capture model, record timing
    if (ctx.event.type === "llm_request") {
      llmStart = performance.now();
      const req = ctx.event as LlmRequestEvent;
      lastModel = req.config.model;
      return spanAgentLoop(sessionId, currentIteration, async () => {
        return await next();
      });
    }

    // LLM response — write trace span using captured model
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      if (traceWriter && traceId && iterSpanId) {
        const provider = lastModel.includes("/")
          ? lastModel.split("/")[0]
          : lastModel;
        await traceWriter.writeLLMSpan(
          traceId,
          agentId,
          iterSpanId,
          lastModel,
          provider,
          {
            prompt: e.usage?.promptTokens ?? 0,
            completion: e.usage?.completionTokens ?? 0,
          },
          performance.now() - llmStart,
          correlationIds,
        );
      }
      return next();
    }

    // Tool call — wrap in OTEL span, record timing
    if (ctx.event.type === "tool_call") {
      const toolStart = performance.now();
      const e = ctx.event as ToolCallEvent;
      return spanToolCall(e.name, async () => {
        const resolution = await next();
        // Write tool span after execution
        if (traceWriter && traceId && iterSpanId && resolution?.type === "tool") {
          await traceWriter.writeToolSpan(
            traceId,
            agentId,
            iterSpanId,
            e.name,
            resolution.result.success,
            performance.now() - toolStart,
            e.arguments,
            correlationIds,
          );
        }
        return resolution;
      });
    }

    // Complete/error — end trace
    if (ctx.event.type === "complete" || ctx.event.type === "error") {
      if (iterSpanId && traceWriter && traceId) {
        await traceWriter.endSpan(
          traceId,
          iterSpanId,
          performance.now() - iterStart,
        );
      }
      if (traceWriter && traceId) {
        await traceWriter.endTrace(
          traceId,
          ctx.event.type === "complete" ? "completed" : "failed",
          currentIteration,
        ).catch(() => {});
      }
      return next();
    }

    return next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middlewares/observability_test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middlewares/observability.ts src/agent/middlewares/observability_test.ts
git commit -m "feat(kaku): add observabilityMiddleware"
```

---

## Task 9: Context refresh middleware (`middlewares/context_refresh.ts`)

**Files:**
- Create: `src/agent/middlewares/context_refresh.ts`
- Test: `src/agent/middlewares/context_refresh_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middlewares/context_refresh_test.ts
import { assertEquals } from "@std/assert";
import { contextRefreshMiddleware } from "./context_refresh.ts";
import type { LlmRequestEvent, ToolResultEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";

function makeSession(): SessionState {
  return {
    agentId: "a", sessionId: "s",
    memoryTopics: ["old-topic"],
    memoryFiles: ["old-file.md"],
    currentIteration: 0,
  };
}

Deno.test("contextRefreshMiddleware reloads skills after write_file to skills/", async () => {
  let reloaded = false;
  const skills = { reload: () => { reloaded = true; return Promise.resolve(); } };
  const memory = { listTopics: () => Promise.resolve(["t1"]) };
  const refreshFiles = () => Promise.resolve(["new.md"]);

  const mw = contextRefreshMiddleware({ skills, memory, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  // tool_result for write_file to skills/
  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result",
    callId: "tc1", name: "write_file",
    arguments: { path: "skills/new.md", content: "# Skill", dry_run: false },
    result: { success: true, output: "written" },
  };

  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  // Refresh happens on next llm_request
  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request", messages: [], tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));

  assertEquals(reloaded, true);
});

Deno.test("contextRefreshMiddleware reloads memory files after write_file to memories/", async () => {
  const skills = { reload: () => Promise.resolve() };
  const memory = { listTopics: () => Promise.resolve([]) };
  const refreshFiles = () => Promise.resolve(["new-mem.md"]);

  const mw = contextRefreshMiddleware({ skills, memory, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result",
    callId: "tc1", name: "write_file",
    arguments: { path: "memories/project.md", content: "# Mem", dry_run: false },
    result: { success: true, output: "written" },
  };
  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request", messages: [], tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));

  assertEquals(session.memoryFiles, ["new-mem.md"]);
});

Deno.test("contextRefreshMiddleware reloads topics after memory remember/forget", async () => {
  const skills = { reload: () => Promise.resolve() };
  const memory = { listTopics: () => Promise.resolve(["new-topic"]) };
  const refreshFiles = () => Promise.resolve([]);

  const mw = contextRefreshMiddleware({ skills, memory, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result",
    callId: "tc1", name: "memory",
    arguments: { action: "remember", topic: "cats", content: "cats are great" },
    result: { success: true, output: "remembered" },
  };
  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request", messages: [], tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));

  assertEquals(session.memoryTopics, ["new-topic"]);
});

Deno.test("contextRefreshMiddleware ignores dry_run writes", async () => {
  let reloaded = false;
  const skills = { reload: () => { reloaded = true; return Promise.resolve(); } };
  const memory = { listTopics: () => Promise.resolve([]) };
  const refreshFiles = () => Promise.resolve([]);

  const mw = contextRefreshMiddleware({ skills, memory, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result",
    callId: "tc1", name: "write_file",
    arguments: { path: "skills/new.md", content: "# Skill", dry_run: true },
    result: { success: true, output: "preview" },
  };
  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request", messages: [], tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));

  assertEquals(reloaded, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middlewares/context_refresh_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middlewares/context_refresh.ts
import type { ToolResultEvent } from "../events.ts";
import type { Middleware } from "../middleware.ts";

interface ContextRefreshState {
  reloadSkills: boolean;
  reloadMemoryFiles: boolean;
  reloadMemoryTopics: boolean;
}

export interface ContextRefreshDeps {
  skills: { reload(): Promise<void> };
  memory: { listTopics(): Promise<string[]> };
  refreshMemoryFiles: (() => Promise<string[]>) | undefined;
}

export function contextRefreshMiddleware(
  deps: ContextRefreshDeps,
): Middleware {
  let refreshState: ContextRefreshState = {
    reloadSkills: false,
    reloadMemoryFiles: false,
    reloadMemoryTopics: false,
  };
  let lastRefreshedIteration = 0;

  return async (ctx, next) => {
    // Apply pending refreshes at the start of a new iteration
    if (
      ctx.event.type === "llm_request" &&
      ctx.event.iterationId > lastRefreshedIteration
    ) {
      if (refreshState.reloadSkills) {
        await deps.skills.reload();
      }
      if (refreshState.reloadMemoryFiles && deps.refreshMemoryFiles) {
        ctx.session.memoryFiles = await deps.refreshMemoryFiles();
      }
      if (refreshState.reloadMemoryTopics) {
        ctx.session.memoryTopics = await deps.memory.listTopics();
      }
      lastRefreshedIteration = ctx.event.iterationId;
      refreshState = {
        reloadSkills: false,
        reloadMemoryFiles: false,
        reloadMemoryTopics: false,
      };
    }

    // Detect refresh triggers on tool_result
    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      if (e.result.success) {
        applyRefreshDetection(refreshState, e.name, e.arguments);
      }
    }

    return next();
  };
}

function applyRefreshDetection(
  state: ContextRefreshState,
  tool: string,
  args: Record<string, unknown>,
): void {
  if (tool === "write_file") {
    if (args.dry_run !== false) return;
    const path = normalizeWorkspaceRelativePath(args.path);
    if (path?.startsWith("skills/")) state.reloadSkills = true;
    if (path?.startsWith("memories/")) state.reloadMemoryFiles = true;
    return;
  }

  if (tool === "memory") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "remember" || action === "forget") {
      state.reloadMemoryTopics = true;
    }
  }
}

function normalizeWorkspaceRelativePath(path: unknown): string | null {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middlewares/context_refresh_test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middlewares/context_refresh.ts src/agent/middlewares/context_refresh_test.ts
git commit -m "feat(kaku): add contextRefreshMiddleware"
```

---

## Task 10: A2A task middleware (`middlewares/a2a_task.ts`)

Broker-only middleware. Wraps tool execution with privilege elevation detection. Reports task lifecycle transitions.

**Files:**
- Create: `src/agent/middlewares/a2a_task.ts`
- Test: `src/agent/middlewares/a2a_task_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/middlewares/a2a_task_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import { a2aTaskMiddleware, PrivilegeElevationPause } from "./a2a_task.ts";
import type { CompleteEvent, ErrorEvent, ToolCallEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";
import type { Task } from "../../messaging/a2a/types.ts";

function makeTask(): Task {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: "WORKING", timestamp: new Date().toISOString() },
    history: [],
    artifacts: [],
  };
}

function makeSession(task?: Task): SessionState {
  return {
    agentId: "agent-1", sessionId: "s",
    memoryTopics: [], memoryFiles: [],
    currentIteration: 1,
    canonicalTask: task ?? makeTask(),
  };
}

Deno.test("a2aTaskMiddleware passes tool_call through to next and returns resolution", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => {
      reportedTasks.push(task);
      return Promise.resolve();
    },
  });

  const event: ToolCallEvent = {
    eventId: 2, timestamp: Date.now(), iterationId: 1,
    type: "tool_call", callId: "tc1", name: "shell",
    arguments: { command: "ls" },
  };

  const toolResolution = {
    type: "tool" as const,
    result: { success: true, output: "file.txt" },
  };

  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(toolResolution),
  );

  assertEquals(result, toolResolution);
  assertEquals(reportedTasks.length, 0);
});

Deno.test("a2aTaskMiddleware throws PrivilegeElevationPause on privilege elevation", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => {
      reportedTasks.push(task);
      return Promise.resolve();
    },
  });

  const event: ToolCallEvent = {
    eventId: 2, timestamp: Date.now(), iterationId: 1,
    type: "tool_call", callId: "tc1", name: "shell",
    arguments: { command: "rm -rf /" },
  };

  const toolResolution = {
    type: "tool" as const,
    result: {
      success: false,
      output: "",
      error: {
        code: "PRIVILEGE_ELEVATION_REQUIRED",
        context: {
          suggestedGrants: [{ permission: "run", resource: "rm" }],
          privilegeElevationScopes: ["once"],
          command: "rm -rf /",
          binary: "rm",
          elevationAvailable: true,
          privilegeElevationSupported: true,
        },
        recovery: "Approve to execute",
      },
    },
  };

  await assertRejects(
    () =>
      mw(
        { event, session: makeSession() },
        () => Promise.resolve(toolResolution),
      ),
    PrivilegeElevationPause,
  );

  assertEquals(reportedTasks.length, 1);
  assertEquals(reportedTasks[0].status.state, "INPUT_REQUIRED");
});

Deno.test("a2aTaskMiddleware reports COMPLETED on complete event", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => {
      reportedTasks.push(task);
      return Promise.resolve();
    },
  });

  const event: CompleteEvent = {
    eventId: 5, timestamp: Date.now(), iterationId: 2,
    type: "complete", content: "final answer",
  };

  await mw(
    { event, session: makeSession() },
    () => Promise.resolve(undefined),
  );

  assertEquals(reportedTasks.length, 1);
  assertEquals(reportedTasks[0].status.state, "COMPLETED");
});

Deno.test("a2aTaskMiddleware reports FAILED on error event", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => {
      reportedTasks.push(task);
      return Promise.resolve();
    },
  });

  const event: ErrorEvent = {
    eventId: 5, timestamp: Date.now(), iterationId: 3,
    type: "error", code: "max_iterations", recovery: "try again",
  };

  await mw(
    { event, session: makeSession() },
    () => Promise.resolve(undefined),
  );

  assertEquals(reportedTasks.length, 1);
  const state = reportedTasks[0].status.state;
  assertEquals(state === "FAILED" || state === "CANCELED", true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/middlewares/a2a_task_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/middlewares/a2a_task.ts
import type { Task } from "../../messaging/a2a/types.ts";
import {
  mapPrivilegeElevationPauseToInputRequiredTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../../messaging/a2a/task_mapping.ts";
import {
  extractRuntimePrivilegeElevationPause,
} from "../runtime_message_mapping.ts";
import type {
  CompleteEvent,
  ErrorEvent,
  ToolCallEvent,
  ToolResolution,
} from "../events.ts";
import type { Middleware } from "../middleware.ts";

export class PrivilegeElevationPause extends Error {
  constructor(public readonly task: Task) {
    super("Privilege elevation pause");
    this.name = "PrivilegeElevationPause";
  }
}

export interface A2ATaskDeps {
  reportTaskResult(task: Task): Promise<void>;
}

export function a2aTaskMiddleware(deps: A2ATaskDeps): Middleware {
  return async (ctx, next) => {
    const task = ctx.session.canonicalTask;

    // Wrap tool_call: detect privilege elevation after execution
    if (ctx.event.type === "tool_call" && task) {
      const resolution = (await next()) as ToolResolution | undefined;

      if (resolution?.type === "tool") {
        const pause = extractRuntimePrivilegeElevationPause(resolution.result);
        if (pause) {
          const toolEvent = ctx.event as ToolCallEvent;
          const pausedTask = mapPrivilegeElevationPauseToInputRequiredTask(
            task,
            {
              grants: pause.grants,
              scope: pause.scope,
              prompt: pause.prompt,
              command: pause.command,
              binary: pause.binary,
              pendingTool: {
                tool: toolEvent.name,
                args: toolEvent.arguments,
                toolCallId: toolEvent.callId,
              },
              expiresAt: pause.expiresAt,
            },
          );
          await deps.reportTaskResult(pausedTask);
          throw new PrivilegeElevationPause(pausedTask);
        }
      }

      return resolution;
    }

    // Report COMPLETED on complete event
    if (ctx.event.type === "complete" && task) {
      const e = ctx.event as CompleteEvent;
      const completed = mapTaskResultToCompletion(task, e.content);
      await deps.reportTaskResult(completed);
      return next();
    }

    // Report FAILED on error event
    if (ctx.event.type === "error" && task) {
      const e = ctx.event as ErrorEvent;
      const failed = mapTaskErrorToTerminalStatus(
        task,
        new Error(e.code),
      );
      await deps.reportTaskResult(failed);
      return next();
    }

    return next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/middlewares/a2a_task_test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/middlewares/a2a_task.ts src/agent/middlewares/a2a_task_test.ts
git commit -m "feat(kaku): add a2aTaskMiddleware with privilege elevation"
```

---

## Task 11: AgentRunner + factory functions (`runner.ts`)

**Files:**
- Create: `src/agent/runner.ts`
- Test: `src/agent/runner_test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/runner_test.ts
import { assertEquals } from "@std/assert";
import { AgentRunner } from "./runner.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import { InMemoryEventStore } from "./event_store.ts";
import type { LlmResolution } from "./events.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { Message } from "../shared/types.ts";

class StubMemory implements Pick<MemoryPort, "getMessages" | "addMessage"> {
  messages: Message[] = [];
  addMessage(msg: Message): Promise<void> {
    this.messages.push(msg);
    return Promise.resolve();
  }
  getMessages(): Message[] {
    return [...this.messages];
  }
}

function makeSession(): SessionState {
  return {
    agentId: "agent-1", sessionId: "sess-1",
    memoryTopics: [], memoryFiles: [],
    currentIteration: 0,
  };
}

Deno.test("AgentRunner orchestrates kernel + pipeline to completion", async () => {
  const pipeline = new MiddlewarePipeline();

  // LLM middleware: returns text-only response
  pipeline.use(async (ctx, next) => {
    if (ctx.event.type === "llm_request") {
      const resolution: LlmResolution = {
        type: "llm",
        content: "Hello!",
        finishReason: "stop",
      };
      return resolution;
    }
    return next();
  });

  const store = new InMemoryEventStore();
  const memory = new StubMemory();
  const session = makeSession();

  const runner = new AgentRunner(pipeline, store, session, memory);
  const result = await runner.run({
    getMessages: () => [{ role: "user", content: "hi" }],
    toolDefinitions: [],
    llmConfig: { model: "test" },
    maxIterations: 5,
  });

  assertEquals(result.content, "Hello!");
  assertEquals(result.finishReason, "stop");

  const events = await store.getEvents();
  // llm_request, llm_response, complete (final)
  assertEquals(events.length, 3);
  assertEquals(events[0].type, "llm_request");
  assertEquals(events[1].type, "llm_response");
  assertEquals(events[2].type, "complete");
});

Deno.test("AgentRunner handles tool calls across iterations", async () => {
  const pipeline = new MiddlewarePipeline();
  let llmCalls = 0;

  // LLM middleware
  pipeline.use(async (ctx, next) => {
    if (ctx.event.type === "llm_request") {
      llmCalls++;
      if (llmCalls === 1) {
        return {
          type: "llm" as const,
          content: "",
          toolCalls: [
            { id: "tc1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
          ],
        };
      }
      return { type: "llm" as const, content: "Done!", finishReason: "stop" };
    }
    return next();
  });

  // Tool middleware
  pipeline.use(async (ctx, next) => {
    if (ctx.event.type === "tool_call") {
      return { type: "tool" as const, result: { success: true, output: "file.txt" } };
    }
    return next();
  });

  const memory = new StubMemory();
  const runner = new AgentRunner(
    pipeline,
    new InMemoryEventStore(),
    makeSession(),
    memory,
  );
  const result = await runner.run({
    getMessages: () => [{ role: "user", content: "list files" }],
    toolDefinitions: [],
    llmConfig: { model: "test" },
    maxIterations: 5,
  });

  assertEquals(result.content, "Done!");
  assertEquals(llmCalls, 2);
});

Deno.test("AgentRunner returns last assistant message on max_iterations", async () => {
  const pipeline = new MiddlewarePipeline();

  // Always return tool calls
  pipeline.use(async (ctx, next) => {
    if (ctx.event.type === "llm_request") {
      return {
        type: "llm" as const,
        content: "still thinking...",
        toolCalls: [
          { id: "tc", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
        ],
      };
    }
    return next();
  });
  pipeline.use(async (ctx, next) => {
    if (ctx.event.type === "tool_call") {
      return { type: "tool" as const, result: { success: true, output: "ok" } };
    }
    return next();
  });

  const memory = new StubMemory();

  // Memory middleware to capture messages
  const memPipeline = new MiddlewarePipeline();
  memPipeline.use(async (ctx, next) => {
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as { content: string; toolCalls?: unknown[] };
      await memory.addMessage({
        role: "assistant",
        content: e.content || "",
        tool_calls: e.toolCalls as never,
      });
    }
    if (ctx.event.type === "tool_result") {
      const e = ctx.event as { callId: string; name: string; result: { output: string } };
      await memory.addMessage({
        role: "tool",
        content: e.result.output,
        name: e.name,
        tool_call_id: e.callId,
      });
    }
    return next();
  });
  // Chain with existing middleware
  memPipeline.use(async (ctx, next) => {
    if (ctx.event.type === "llm_request") {
      return {
        type: "llm" as const,
        content: "still thinking...",
        toolCalls: [
          { id: "tc", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
        ],
      };
    }
    return next();
  });
  memPipeline.use(async (ctx, next) => {
    if (ctx.event.type === "tool_call") {
      return { type: "tool" as const, result: { success: true, output: "ok" } };
    }
    return next();
  });

  const runner = new AgentRunner(
    memPipeline,
    new InMemoryEventStore(),
    makeSession(),
    memory,
  );
  const result = await runner.run({
    getMessages: () => memory.getMessages(),
    toolDefinitions: [],
    llmConfig: { model: "test" },
    maxIterations: 1,
  });

  assertEquals(result.finishReason, "max_iterations");
  assertEquals(result.content, "still thinking...");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check src/agent/runner_test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent/runner.ts
import type { AgentResponse } from "./types.ts";
import type { FinalEvent } from "./events.ts";
import { agentKernel } from "./kernel.ts";
import type { KernelInput } from "./kernel.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import type { EventStore } from "./event_store.ts";
import { PrivilegeElevationPause } from "./middlewares/a2a_task.ts";
import type { Message } from "../shared/types.ts";

interface MemoryReader {
  getMessages(): Message[];
}

export class AgentRunner {
  constructor(
    private pipeline: MiddlewarePipeline,
    private eventStore: EventStore,
    private session: SessionState,
    private memory: MemoryReader,
  ) {}

  async run(input: KernelInput): Promise<AgentResponse> {
    const kernel = agentKernel(input);
    let next = await kernel.next();

    try {
      while (!next.done) {
        const event = next.value;
        await this.eventStore.commit(event);
        const resolution = await this.pipeline.execute(
          event,
          this.session,
        );
        next = await kernel.next(resolution);
      }

      const finalEvent = next.value;
      await this.eventStore.commit(finalEvent);
      // Pass final event through pipeline (observation for a2a/observability)
      await this.pipeline.execute(finalEvent, this.session);
      return this.toAgentResult(finalEvent);
    } catch (e) {
      if (e instanceof PrivilegeElevationPause) {
        return { content: "", finishReason: "privilege_elevation_pause" };
      }
      throw e;
    }
  }

  private toAgentResult(event: FinalEvent): AgentResponse {
    if (event.type === "complete") {
      return {
        content: event.content,
        finishReason: event.finishReason ?? "stop",
      };
    }

    // Error (max_iterations) — return last assistant message
    const messages = this.memory.getMessages();
    const last = messages.findLast((m) => m.role === "assistant");
    return {
      content: last?.content ??
        "Max iterations reached without a final response.",
      finishReason: "max_iterations",
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/agent/runner_test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/runner.ts src/agent/runner_test.ts
git commit -m "feat(kaku): add AgentRunner orchestrating kernel + pipeline"
```

---

## Task 12: Wire `loop.ts` to `createLocalRunner`

Replace `processAgentLoopMessage()` call in `AgentLoop.processMessage()` with a `createLocalRunner().run()` call.

**Files:**
- Modify: `src/agent/loop.ts`
- Test: verify existing `src/agent/loop_test.ts` still passes

- [ ] **Step 1: Run existing tests to establish baseline**

Run: `deno test src/agent/loop_test.ts`
Expected: all 5 tests PASS

- [ ] **Step 2: Replace `processMessage()` in `loop.ts`**

Remove the import of `processAgentLoopMessage` from `./loop_process.ts` and add the new imports. Replace the body of `processMessage()`:

In `src/agent/loop.ts`, replace the import line:

```typescript
// Remove this:
import { processAgentLoopMessage } from "./loop_process.ts";
// Add these:
import { AgentRunner } from "./runner.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import { InMemoryEventStore } from "./event_store.ts";
import { llmMiddleware } from "./middlewares/llm.ts";
import { toolMiddleware } from "./middlewares/tool.ts";
import { memoryMiddleware } from "./middlewares/memory.ts";
import { observabilityMiddleware } from "./middlewares/observability.ts";
import { contextRefreshMiddleware } from "./middlewares/context_refresh.ts";
```

Replace the `processMessage()` method body (lines 213-235):

```typescript
  async processMessage(userMessage: string): Promise<AgentResponse> {
    await this.initialize();

    // Add user message to memory
    await this.memory.addMessage({ role: "user", content: userMessage });

    // Build session state
    const session: SessionState = {
      agentId: this.agentId,
      sessionId: this.sessionId,
      memoryTopics: this.memoryTopics,
      memoryFiles: this.memoryFiles,
      currentIteration: 0,
    };

    // Build middleware pipeline
    const pipeline = new MiddlewarePipeline()
      .use(observabilityMiddleware({
        traceWriter: this.traceWriter,
        agentId: this.agentId,
        sessionId: this.sessionId,
        correlationIds: {
          ...(this.taskId ? { taskId: this.taskId } : {}),
          ...(this.contextId ? { contextId: this.contextId } : {}),
        },
      }))
      .use(memoryMiddleware(this.memory))
      .use(contextRefreshMiddleware({
        skills: this.skills,
        memory: this.memory,
        refreshMemoryFiles: () => this.refreshMemoryFiles(),
      }))
      .use(toolMiddleware((name, args) => this.tools.execute(name, args)))
      .use(llmMiddleware((messages, model, temperature, maxTokens, tools) =>
        this.providers.complete(messages, model, temperature, maxTokens, tools)
      ));

    // Build getMessages callback with context building + truncation
    const CHARS_PER_TOKEN = 4;
    const CONTEXT_RATIO = 4;
    const maxChars = (this.config.maxTokens || 4096) * CHARS_PER_TOKEN * CONTEXT_RATIO;
    const getMessages = () => {
      const raw = this.context.buildContextMessages(
        this.memory.getMessages(),
        this.skills.getSkills(),
        this.tools.getDefinitions(),
        session.memoryTopics,
        session.memoryFiles,
        this.getRuntimeGrants?.() ?? [],
      );
      return this.context.truncateContext(raw, maxChars);
    };

    const runner = new AgentRunner(
      pipeline,
      new InMemoryEventStore(),
      session,
      this.memory,
    );

    return await runner.run({
      getMessages,
      toolDefinitions: this.tools.getDefinitions(),
      llmConfig: this.config,
      maxIterations: this.maxIterations,
    });
  }
```

- [ ] **Step 3: Run existing tests to verify non-regression**

Run: `deno test src/agent/loop_test.ts`
Expected: all 5 tests PASS (same behavior, different internals)

- [ ] **Step 4: Run the full unit test suite**

Run: `deno task test`
Expected: no regressions from the wiring change

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts
git commit -m "refactor(kaku): wire AgentLoop.processMessage to Kaku runner"
```

---

## Task 13: Wire `runtime.ts` to `createBrokerRunner`

Replace `executeAgentConversation()` calls in `AgentRuntime` with `createBrokerRunner().run()`.

**Files:**
- Modify: `src/agent/runtime.ts`

- [ ] **Step 1: Run existing tests to establish baseline**

Run: `deno test src/agent/runtime_broker_task_test.ts src/agent/runtime_conversation_test.ts`
Expected: PASS

- [ ] **Step 2: Replace imports in `runtime.ts`**

Remove:
```typescript
import { executeAgentConversation } from "./runtime_conversation.ts";
```

Add:
```typescript
import { AgentRunner } from "./runner.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import { InMemoryEventStore } from "./event_store.ts";
import { llmMiddleware } from "./middlewares/llm.ts";
import { toolMiddleware } from "./middlewares/tool.ts";
import { memoryMiddleware } from "./middlewares/memory.ts";
import { contextRefreshMiddleware } from "./middlewares/context_refresh.ts";
import { a2aTaskMiddleware } from "./middlewares/a2a_task.ts";
```

- [ ] **Step 3: Add `createBrokerRunner` private method to `AgentRuntime`**

Add this method to the class, before `reportCanonicalTaskResult`:

```typescript
  private createBrokerRunner(deps: {
    memory: MemoryPort;
    canonicalTask: Task;
    runtimeGrants?: AgentRuntimeGrantStore;
  }): { runner: AgentRunner; session: SessionState } {
    const session: SessionState = {
      agentId: this.agentId,
      sessionId: `agent:${deps.canonicalTask.contextId ?? deps.canonicalTask.id}`,
      memoryTopics: [],
      memoryFiles: this.memoryFiles,
      currentIteration: 0,
      canonicalTask: deps.canonicalTask,
      runtimeGrants: deps.runtimeGrants?.list(),
    };

    const pipeline = new MiddlewarePipeline()
      .use(memoryMiddleware(deps.memory))
      .use(contextRefreshMiddleware({
        skills: this.skills,
        memory: deps.memory,
        refreshMemoryFiles: () => this.loadMemoryFiles(),
      }))
      .use(a2aTaskMiddleware({
        reportTaskResult: (task) => this.reportCanonicalTaskResult(task),
      }))
      .use(toolMiddleware((name, args) =>
        this.llmToolPort.execTool(name, args, {
          taskId: session.canonicalTask!.id,
          contextId: session.canonicalTask!.contextId,
        })
      ))
      .use(llmMiddleware((messages, model, temperature, maxTokens, tools) =>
        this.llmToolPort.complete(messages, model, temperature, maxTokens, tools)
      ));

    const runner = new AgentRunner(
      pipeline,
      new InMemoryEventStore(),
      session,
      deps.memory,
    );

    return { runner, session };
  }

  private buildBrokerKernelInput(
    memory: MemoryPort,
    session: SessionState,
  ): import("./kernel.ts").KernelInput {
    return {
      getMessages: () =>
        this.context.buildContextMessages(
          memory.getMessages(),
          this.skills.getSkills(),
          this.toolDefinitions,
          session.memoryTopics,
          session.memoryFiles,
          session.runtimeGrants ?? [],
        ),
      toolDefinitions: this.toolDefinitions,
      llmConfig: this.config,
      maxIterations: this.maxIterations,
    };
  }
```

- [ ] **Step 4: Replace `handleTaskSubmitMessage()` body**

Replace lines 182-216 (the entire method body):

```typescript
  private async handleTaskSubmitMessage(
    msg: RuntimeTaskSubmitMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const taskMessage = extractSubmitTaskMessage(payload);
    const inputText = extractRuntimeTaskText(taskMessage);
    const memory = await this.getMemory(`agent:${msg.from}:${this.agentId}`);
    this.memoryFiles = await this.loadMemoryFiles();
    log.info(
      `Canonical task received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    const canonicalTask = createCanonicalTask({
      id: payload.taskId,
      contextId: payload.contextId,
      initialMessage: taskMessage,
    });

    // Report WORKING transition
    const workingTask = transitionTask(canonicalTask, "WORKING");
    await this.reportCanonicalTaskResult(workingTask);

    // Add user message
    if (inputText.trim().length > 0) {
      await memory.addMessage({ role: "user", content: inputText });
    }

    const { runner, session } = this.createBrokerRunner({
      memory,
      canonicalTask: workingTask,
    });
    session.memoryTopics = await memory.listTopics();

    await runner.run(this.buildBrokerKernelInput(memory, session));
  }
```

- [ ] **Step 5: Replace `handleTaskContinueMessage()` body**

Replace lines 218-348 (the entire method body):

```typescript
  private async handleTaskContinueMessage(
    msg: RuntimeTaskContinueMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const continuationMessage = extractContinuationTaskMessage(payload);
    const existing = await this.canonicalTaskPort.getTask(payload.taskId);
    if (!existing) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: payload.taskId },
        "Broker-backed continuation received unknown task",
      );
    }

    const resumed = transitionTask(existing, "WORKING", {
      statusMessage: continuationMessage,
    });
    resumed.history = [...existing.history, continuationMessage];
    await this.reportCanonicalTaskResult(resumed);
    const inputText = extractRuntimeTaskText(continuationMessage);
    const runtimeGrantStore = new AgentRuntimeGrantStore();
    const approvedPrivilegeGrant = extractApprovedPrivilegeElevationGrant(
      existing,
      payload,
    );
    if (approvedPrivilegeGrant) {
      runtimeGrantStore.grantPrivilegeElevation({
        scope: approvedPrivilegeGrant.scope,
        grants: approvedPrivilegeGrant.grants,
        source: approvedPrivilegeGrant.source,
        grantedAt: approvedPrivilegeGrant.grantedAt,
      });
    }
    const pendingTool = approvedPrivilegeGrant
      ? getAwaitedPrivilegeElevationPendingTool(existing.status)
      : undefined;
    const memory = await this.getMemory(`agent:${msg.from}:${this.agentId}`);
    if (this.memoryFiles.length === 0) {
      this.memoryFiles = await this.loadMemoryFiles();
    }

    // Auto-retry pending tool if privilege was approved
    if (approvedPrivilegeGrant && pendingTool) {
      log.info(
        `Canonical continuation received from ${msg.from}: auto-retrying pending tool ${pendingTool.tool}`,
      );
      const result = await this.llmToolPort.execTool(
        pendingTool.tool,
        pendingTool.args,
        { taskId: resumed.id, contextId: resumed.contextId },
      );
      const privilegePause = extractRuntimePrivilegeElevationPause(result);
      if (privilegePause) {
        await this.reportCanonicalTaskResult(
          mapPrivilegeElevationPauseToInputRequiredTask(resumed, {
            grants: privilegePause.grants,
            scope: privilegePause.scope,
            prompt: privilegePause.prompt,
            command: privilegePause.command,
            binary: privilegePause.binary,
            pendingTool,
            expiresAt: privilegePause.expiresAt,
          }),
        );
        log.info(
          `Canonical task paused again in INPUT_REQUIRED for privilege elevation (${msg.from})`,
        );
        return;
      }

      await memory.addMessage({
        role: "tool",
        content: result.success
          ? result.output
          : `Error [${result.error?.code}]: ${
            JSON.stringify(result.error?.context)
          }\nRecovery: ${result.error?.recovery ?? "none"}`,
        name: pendingTool.tool,
        ...(pendingTool.toolCallId
          ? { tool_call_id: pendingTool.toolCallId }
          : {}),
      });
    }

    // Add continuation input
    if (inputText.trim().length > 0) {
      await memory.addMessage({ role: "user", content: inputText });
    }

    log.info(
      `Canonical continuation received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    const { runner, session } = this.createBrokerRunner({
      memory,
      canonicalTask: resumed,
      runtimeGrants: runtimeGrantStore,
    });
    session.memoryTopics = await memory.listTopics();

    await runner.run(this.buildBrokerKernelInput(memory, session));
  }
```

- [ ] **Step 6: Run all tests**

Run: `deno task test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/runtime.ts
git commit -m "refactor(kaku): wire AgentRuntime to Kaku runner"
```

---

## Task 14: Delete old files

**Files:**
- Delete: `src/agent/loop_process.ts`
- Delete: `src/agent/runtime_conversation.ts`
- Delete: `src/agent/conversation_context_refresh.ts`
- Delete: `src/agent/runtime_conversation_test.ts`

- [ ] **Step 1: Verify no other imports remain**

Run: `grep -r "loop_process\|runtime_conversation\|conversation_context_refresh" src/ --include="*.ts" -l`
Expected: only the files themselves and possibly this test file. If `loop.ts` or `runtime.ts` still import them, fix those first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/agent/loop_process.ts
git rm src/agent/runtime_conversation.ts
git rm src/agent/conversation_context_refresh.ts
git rm src/agent/runtime_conversation_test.ts
```

- [ ] **Step 3: Run tests to verify nothing breaks**

Run: `deno task test`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(kaku): delete superseded loop_process, runtime_conversation, conversation_context_refresh"
```

---

## Task 15: Update `mod.ts` exports + full verification

**Files:**
- Modify: `src/agent/mod.ts`

- [ ] **Step 1: Add Kaku exports to `mod.ts`**

Add these lines to `src/agent/mod.ts`:

```typescript
// Kaku kernel
export { AgentRunner } from "./runner.ts";
export { MiddlewarePipeline } from "./middleware.ts";
export type { Middleware, MiddlewareContext, SessionState } from "./middleware.ts";
export { agentKernel } from "./kernel.ts";
export type { KernelInput } from "./kernel.ts";
export { InMemoryEventStore } from "./event_store.ts";
export type { EventStore } from "./event_store.ts";
export type {
  AgentEvent,
  CompleteEvent,
  ErrorEvent,
  EventResolution,
  FinalEvent,
  LlmRequestEvent,
  LlmResolution,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResolution,
  ToolResultEvent,
} from "./events.ts";
```

- [ ] **Step 2: Run lint**

Run: `deno task lint`
Expected: no errors

- [ ] **Step 3: Run type check**

Run: `deno task check`
Expected: no errors

- [ ] **Step 4: Run full test suite**

Run: `deno task test`
Expected: all tests PASS

- [ ] **Step 5: Run E2E tests (if Ollama available)**

Run: `deno task test:e2e`
Expected: E2E scenarios PASS (same behavior, different internals)

- [ ] **Step 6: Commit**

```bash
git add src/agent/mod.ts
git commit -m "feat(kaku): export kernel types from mod.ts"
```

---

## Summary

| # | Task | New lines | Deleted lines |
|---|---|---|---|
| 1 | `events.ts` + test | ~150 | 0 |
| 2 | `middleware.ts` + test | ~100 | 0 |
| 3 | `event_store.ts` + test | ~40 | 0 |
| 4 | `kernel.ts` + test | ~250 | 0 |
| 5 | `middlewares/llm.ts` + test | ~80 | 0 |
| 6 | `middlewares/tool.ts` + test | ~60 | 0 |
| 7 | `middlewares/memory.ts` + test | ~120 | 0 |
| 8 | `middlewares/observability.ts` + test | ~200 | 0 |
| 9 | `middlewares/context_refresh.ts` + test | ~150 | 0 |
| 10 | `middlewares/a2a_task.ts` + test | ~150 | 0 |
| 11 | `runner.ts` + test | ~150 | 0 |
| 12 | Wire `loop.ts` | ~50 | ~25 |
| 13 | Wire `runtime.ts` | ~100 | ~100 |
| 14 | Delete old files | 0 | ~715 |
| 15 | Exports + verification | ~20 | 0 |
| **Total** | | **~1620** | **~840** |
