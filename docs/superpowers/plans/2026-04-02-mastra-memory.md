# Mastra Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate agent memory to async MemoryPort, move message assembly from kernel to llmMiddleware, add MastraMemory (PgStore + PgVector) with EmbedderPort DI (fastembed local, Ollama cloud).

**Architecture:** Phase 1 makes MemoryPort async + removes messages from kernel (breaking change). Phase 2 adds EmbedderPort. Phase 3 adds MastraMemory. Phase 4 wires everything with opt-in via DATABASE_URL.

**Tech Stack:** @mastra/memory, @mastra/pg, @mastra/fastembed, Deno, TypeScript strict

**Spec:** `docs/superpowers/specs/2026-04-02-mastra-memory-design.md`

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/agent/embedder_port.ts` | EmbedderPort interface |
| `src/agent/embedders/mastra.ts` | MastraEmbedder (fastembed, local) |
| `src/agent/embedders/ollama.ts` | OllamaEmbedder (cloud) |
| `src/agent/embedders/noop.ts` | NoopEmbedder (tests) |
| `src/agent/memory_mastra.ts` | MastraMemory implements MemoryPort |
| `src/agent/memory_mastra_test.ts` | MastraMemory tests |
| `src/agent/memory_factory.ts` | createMemory() + createEmbedder() |

### Modified files

| File | Change |
|---|---|
| `src/agent/memory_port.ts` | getMessages/getRecentMessages → async, add semanticRecall, rename recall → recallTopic |
| `src/agent/memory.ts` | Wrap sync → async |
| `src/agent/memory_kvdex.ts` | Wrap sync → async |
| `src/agent/events.ts` | Remove messages from LlmRequestEvent |
| `src/agent/kernel.ts` | Remove getMessages from KernelInput, stop baking messages |
| `src/agent/middlewares/llm.ts` | Accept LlmMiddlewareDeps (getMessages + complete) |
| `src/agent/runner.ts` | Adapt factories: buildMessages async, llmMiddleware deps |
| `src/agent/loop.ts` | Adapt for async MemoryPort |
| `src/agent/runtime.ts` | Adapt for async MemoryPort |
| `src/agent/tools/memory.ts` | Rename recall → recallTopic |
| `src/agent/mod.ts` | Export new types |
| `deno.json` | Add @mastra/memory, @mastra/pg, @mastra/fastembed |
| All test files with FakeMemory/StubMemory | Adapt getMessages to async |

---

## Phase 1: Async MemoryPort + Kernel refactor (breaking change)

### Task 1: Make MemoryPort async

**Files:**
- Modify: `src/agent/memory_port.ts`

- [ ] **Step 1: Update the interface**

```typescript
// src/agent/memory_port.ts
import type { Message } from "../shared/types.ts";

export interface LongTermFact {
  topic: string;
  content: string;
  source?: "user" | "agent" | "tool";
  confidence?: number;
  timestamp: string;
}

/**
 * Agent memory access port (DDD).
 * Two facets: conversations (session-scoped) + long-term facts (agent-scoped).
 * All read methods are async to support DB-backed implementations.
 */
export interface MemoryPort {
  load(): Promise<void>;
  close(): void;

  // Conversations (async)
  addMessage(message: Message): Promise<void>;
  getMessages(): Promise<Message[]>;
  getRecentMessages(count: number): Promise<Message[]>;
  clear(): Promise<void>;
  readonly count: number;

  // Semantic search (returns relevant past messages via vector similarity)
  semanticRecall(query: string, topK?: number): Promise<Message[]>;

  // Long-term facts
  remember(fact: Omit<LongTermFact, "timestamp">): Promise<void>;
  recallTopic(topic: string, limit?: number): Promise<LongTermFact[]>;
  listTopics(): Promise<string[]>;
  forgetTopic(topic: string): Promise<void>;
}
```

- [ ] **Step 2: Commit (will break compilation — that's expected)**

```bash
git add src/agent/memory_port.ts
git commit -m "refactor(memory): make MemoryPort async, add semanticRecall, rename recall→recallTopic"
```

---

### Task 2: Adapt legacy Memory (KV) to async MemoryPort

**Files:**
- Modify: `src/agent/memory.ts`
- Modify: `src/agent/memory_test.ts`

- [ ] **Step 1: Update Memory class**

Change `getMessages()` and `getRecentMessages()` to return `Promise<Message[]>`. Add `semanticRecall()` (returns empty — no vector search in KV impl). Rename `recall()` → `recallTopic()`.

```typescript
// In Memory class:
async getMessages(): Promise<Message[]> {
  return [...this.messages];
}

async getRecentMessages(count: number): Promise<Message[]> {
  return this.messages.slice(-count);
}

async semanticRecall(_query: string, _topK?: number): Promise<Message[]> {
  return []; // No vector search in legacy KV implementation
}

// Rename recall → recallTopic (same body)
async recallTopic(topic: string, _limit?: number): Promise<LongTermFact[]> {
  // ... existing recall body unchanged
}
```

- [ ] **Step 2: Update tests**

All `memory.getMessages()` calls in `memory_test.ts` become `await memory.getMessages()`. Same for `getRecentMessages`.

- [ ] **Step 3: Run tests**

Run: `deno test --allow-all src/agent/memory_test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/memory.ts src/agent/memory_test.ts
git commit -m "refactor(memory): adapt Memory (KV) to async MemoryPort"
```

---

### Task 3: Adapt KvdexMemory to async MemoryPort

**Files:**
- Modify: `src/agent/memory_kvdex.ts`
- Modify: `src/agent/memory_kvdex_test.ts`

Same changes as Task 2 but for KvdexMemory. `getMessages()` and `getRecentMessages()` already read from an in-memory cache — just wrap the return in a Promise. Add `semanticRecall()` returning empty. Rename `recall()` → `recallTopic()`.

- [ ] **Step 1: Update KvdexMemory**
- [ ] **Step 2: Update tests**
- [ ] **Step 3: Run tests**

Run: `deno test --allow-all src/agent/memory_kvdex_test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/memory_kvdex.ts src/agent/memory_kvdex_test.ts
git commit -m "refactor(memory): adapt KvdexMemory to async MemoryPort"
```

---

### Task 4: Adapt MemoryTool (rename recall → recallTopic)

**Files:**
- Modify: `src/agent/tools/memory.ts`

- [ ] **Step 1: Rename the recall call**

In the `execute()` method, change `this.memory.recall(topic)` to `this.memory.recallTopic(topic)`.

- [ ] **Step 2: Run tests**

Run: `deno test --allow-all src/agent/tools/`

- [ ] **Step 3: Commit**

```bash
git add src/agent/tools/memory.ts
git commit -m "refactor(memory): rename recall→recallTopic in MemoryTool"
```

---

### Task 5: Remove messages from LlmRequestEvent + KernelInput

This is the core architectural change: the kernel no longer bakes messages. The llmMiddleware assembles them.

**Files:**
- Modify: `src/agent/events.ts`
- Modify: `src/agent/kernel.ts`
- Modify: `src/agent/kernel_test.ts`

- [ ] **Step 1: Remove messages from LlmRequestEvent**

```typescript
// src/agent/events.ts — LlmRequestEvent becomes:
export interface LlmRequestEvent extends BaseEvent {
  type: "llm_request";
  tools: ToolDefinition[];
  config: AgentConfig;
}
```

Remove the `Message` import if no longer used in events.ts (check other event types — `ToolResultEvent` etc don't use it directly, but the `messages` field was the only one).

- [ ] **Step 2: Remove getMessages from KernelInput**

```typescript
// src/agent/kernel.ts — KernelInput becomes:
export interface KernelInput {
  toolDefinitions: ToolDefinition[];
  llmConfig: AgentConfig;
  maxIterations: number;
}
```

Update the kernel's `llm_request` yield to not include messages:

```typescript
const rawLlm = yield event<AgentEvent>(
  {
    type: "llm_request",
    tools: input.toolDefinitions,
    config: input.llmConfig,
  },
  iteration,
);
```

Remove the `Message` import from kernel.ts if no longer needed.

- [ ] **Step 3: Update kernel tests**

All tests that check `llm_request` events must not expect a `messages` field. Tests that create `KernelInput` must not include `getMessages`. Update `makeInput()`:

```typescript
function makeInput(overrides?: Partial<KernelInput>): KernelInput {
  return {
    toolDefinitions: [],
    llmConfig: { model: "test/model" },
    maxIterations: 5,
    ...overrides,
  };
}
```

- [ ] **Step 4: Run kernel tests**

Run: `deno test --allow-all src/agent/kernel_test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/agent/events.ts src/agent/kernel.ts src/agent/kernel_test.ts
git commit -m "refactor(kaku): remove messages from LlmRequestEvent and KernelInput"
```

---

### Task 6: Refactor llmMiddleware to assemble messages

**Files:**
- Modify: `src/agent/middlewares/llm.ts`
- Modify: `src/agent/middlewares/llm_test.ts`

- [ ] **Step 1: Change llmMiddleware signature**

```typescript
// src/agent/middlewares/llm.ts
import type { LLMResponse, Message, ToolDefinition } from "../../shared/types.ts";
import type { LlmRequestEvent, LlmResolution } from "../events.ts";
import type { Middleware } from "../middleware.ts";

export type CompleteFn = (
  messages: Message[],
  model: string,
  temperature?: number,
  maxTokens?: number,
  tools?: ToolDefinition[],
) => Promise<LLMResponse>;

export type GetMessagesFn = () => Promise<Message[]>;

export interface LlmMiddlewareDeps {
  getMessages: GetMessagesFn;
  complete: CompleteFn;
}

export function llmMiddleware(deps: LlmMiddlewareDeps): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== "llm_request") return next();
    const req = ctx.event as LlmRequestEvent;
    const messages = await deps.getMessages();
    const response = await deps.complete(
      messages, req.config.model, req.config.temperature,
      req.config.maxTokens, req.tools,
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

- [ ] **Step 2: Update tests**

```typescript
// src/agent/middlewares/llm_test.ts
Deno.test("llmMiddleware resolves llm_request events", async () => {
  const completeFn = (_messages: unknown[], _model: string) =>
    Promise.resolve({
      content: "response", toolCalls: [], finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  const mw = llmMiddleware({
    getMessages: () => Promise.resolve([{ role: "user", content: "hi" }]),
    complete: completeFn,
  });
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request" as const,
    tools: [], config: { model: "test/m" },
  };
  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(undefined),
  );
  assertEquals(result?.type, "llm");
});
```

- [ ] **Step 3: Run tests**

Run: `deno test --allow-all src/agent/middlewares/llm_test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/middlewares/llm.ts src/agent/middlewares/llm_test.ts
git commit -m "refactor(kaku): llmMiddleware assembles messages via async getMessages"
```

---

### Task 7: Adapt runner factories

**Files:**
- Modify: `src/agent/runner.ts`
- Modify: `src/agent/runner_test.ts`

- [ ] **Step 1: Update MemoryReader to async**

```typescript
interface MemoryReader {
  getMessages(): Promise<Message[]>;
}
```

Update `toAgentResult` to await:
```typescript
private async toAgentResult(event: FinalEvent): Promise<AgentResponse> {
  // ...
  const messages = await this.memory.getMessages();
  // ...
}
```

And `run()` must await `toAgentResult`:
```typescript
return await this.toAgentResult(finalEvent);
```

- [ ] **Step 2: Update LocalRunnerDeps**

```typescript
export interface LocalRunnerDeps {
  // ... existing fields ...
  // CHANGE: buildMessages becomes async
  buildMessages: (
    memoryTopics: string[],
    memoryFiles: string[],
  ) => Promise<Message[]>;
  // REMOVE: no more getMessages in KernelInput
}
```

Update `createLocalRunner`:
```typescript
const getMessages = () =>
  deps.buildMessages(session.memoryTopics, session.memoryFiles);

// llmMiddleware now takes deps object
pipeline.use(llmMiddleware({ getMessages, complete: deps.complete }));

// KernelInput no longer has getMessages
return {
  runner: ...,
  session,
  kernelInput: {
    toolDefinitions: deps.toolDefinitions,
    llmConfig: deps.llmConfig,
    maxIterations: deps.maxIterations,
  },
};
```

- [ ] **Step 3: Update BrokerRunnerDeps** (same pattern)

- [ ] **Step 4: Update runner tests**

All `StubMemory.getMessages()` becomes async. All `getMessages` in KernelInput construction is removed. LLM middleware stubs change to `llmMiddleware({ getMessages: ..., complete: ... })` pattern or inline middleware.

- [ ] **Step 5: Run tests**

Run: `deno test --allow-all src/agent/runner_test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/agent/runner.ts src/agent/runner_test.ts
git commit -m "refactor(kaku): async MemoryReader + llmMiddleware deps in runner factories"
```

---

### Task 8: Wire loop.ts and runtime.ts

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/runtime.ts`

- [ ] **Step 1: Update loop.ts**

`buildMessages` becomes async (it calls `this.memory.getMessages()` which is now async):

```typescript
buildMessages: async (memoryTopics, memoryFiles) => {
  const raw = this.context.buildContextMessages(
    await this.memory.getMessages(),
    this.skills.getSkills(),
    this.tools.getDefinitions(),
    memoryTopics,
    memoryFiles,
    this.getRuntimeGrants?.() ?? [],
  );
  return this.context.truncateContext(raw, maxChars);
},
```

- [ ] **Step 2: Update runtime.ts** (same pattern for broker buildMessages)

- [ ] **Step 3: Update all remaining test files with FakeMemory/StubMemory**

Files to update:
- `src/agent/loop_test.ts`
- `src/agent/runtime_broker_task_test.ts`
- `src/agent/runtime_ports_wiring_test.ts`
- `src/agent/middlewares/analytics_test.ts` (if it has a memory stub)

All `getMessages(): Message[]` → `getMessages(): Promise<Message[]>` with `return Promise.resolve([...])`.

- [ ] **Step 4: Run full suite**

Run: `deno task test`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts src/agent/runtime.ts src/agent/loop_test.ts \
  src/agent/runtime_broker_task_test.ts src/agent/runtime_ports_wiring_test.ts
git commit -m "refactor(memory): wire async MemoryPort in loop.ts and runtime.ts"
```

---

## Phase 2: EmbedderPort

### Task 9: Create EmbedderPort interface

**Files:**
- Create: `src/agent/embedder_port.ts`

- [ ] **Step 1: Write the interface**

```typescript
// src/agent/embedder_port.ts

export interface EmbedderPort {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly modelName: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/embedder_port.ts
git commit -m "feat(memory): add EmbedderPort interface"
```

---

### Task 10: Create NoopEmbedder (tests) + MastraEmbedder + OllamaEmbedder

**Files:**
- Create: `src/agent/embedders/noop.ts`
- Create: `src/agent/embedders/mastra.ts`
- Create: `src/agent/embedders/ollama.ts`
- Create: `src/agent/embedders/ollama_test.ts`

- [ ] **Step 1: NoopEmbedder**

```typescript
// src/agent/embedders/noop.ts
import type { EmbedderPort } from "../embedder_port.ts";

export class NoopEmbedder implements EmbedderPort {
  readonly dimension = 0;
  readonly modelName = "noop";

  embed(_text: string): Promise<number[]> {
    return Promise.resolve([]);
  }
  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => []));
  }
}
```

- [ ] **Step 2: MastraEmbedder**

```typescript
// src/agent/embedders/mastra.ts
import type { EmbedderPort } from "../embedder_port.ts";

let fastembed: { embed: (texts: string[]) => Promise<{ embeddings: number[][] }> } | null = null;

async function loadFastembed() {
  if (!fastembed) {
    const mod = await import("@mastra/fastembed");
    fastembed = mod.fastembed;
  }
  return fastembed!;
}

export class MastraEmbedder implements EmbedderPort {
  readonly dimension = 384;
  readonly modelName = "fastembed";

  async embed(text: string): Promise<number[]> {
    const fe = await loadFastembed();
    const result = await fe.embed([text]);
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const fe = await loadFastembed();
    const result = await fe.embed(texts);
    return result.embeddings;
  }
}
```

- [ ] **Step 3: OllamaEmbedder**

```typescript
// src/agent/embedders/ollama.ts
import type { EmbedderPort } from "../embedder_port.ts";

export class OllamaEmbedder implements EmbedderPort {
  readonly dimension: number;
  readonly modelName: string;

  constructor(
    private baseUrl: string,
    model = "nomic-embed-text",
    dimension = 768,
  ) {
    this.modelName = model;
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.modelName, input: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
    const body = await res.json();
    return body.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed batch failed: ${res.status}`);
    const body = await res.json();
    return body.embeddings;
  }
}
```

- [ ] **Step 4: OllamaEmbedder test (mock HTTP)**

```typescript
// src/agent/embedders/ollama_test.ts
import { assertEquals } from "@std/assert";
import { OllamaEmbedder } from "./ollama.ts";

Deno.test("OllamaEmbedder calls /api/embed with correct format", async () => {
  const server = Deno.serve({ port: 0 }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/embed") {
      return Response.json({
        model: "nomic-embed-text",
        embeddings: [[0.1, 0.2, 0.3]],
      });
    }
    return new Response("Not Found", { status: 404 });
  });
  const port = server.addr.port;
  const embedder = new OllamaEmbedder(`http://localhost:${port}`, "nomic-embed-text", 3);
  const result = await embedder.embed("hello");
  assertEquals(result, [0.1, 0.2, 0.3]);
  assertEquals(embedder.dimension, 3);
  await server.shutdown();
});

Deno.test("OllamaEmbedder embedBatch returns multiple vectors", async () => {
  const server = Deno.serve({ port: 0 }, () =>
    Response.json({ embeddings: [[0.1, 0.2], [0.3, 0.4]] })
  );
  const port = server.addr.port;
  const embedder = new OllamaEmbedder(`http://localhost:${port}`, "test", 2);
  const result = await embedder.embedBatch(["a", "b"]);
  assertEquals(result, [[0.1, 0.2], [0.3, 0.4]]);
  await server.shutdown();
});
```

- [ ] **Step 5: Run tests**

Run: `deno test --allow-all src/agent/embedders/ollama_test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/agent/embedders/
git commit -m "feat(memory): add NoopEmbedder, MastraEmbedder, OllamaEmbedder"
```

---

## Phase 3: MastraMemory

### Task 11: Create MastraMemory implementation

**Files:**
- Create: `src/agent/memory_mastra.ts`
- Create: `src/agent/memory_mastra_test.ts`

- [ ] **Step 1: Write MastraMemory**

Implements MemoryPort using @mastra/memory with PgStore + PgVector. Maps DenoClaw Messages to Mastra format. Uses EmbedderPort for vector embeddings.

The full implementation follows the spec at `docs/superpowers/specs/2026-04-02-mastra-memory-design.md` section "MastraMemory".

- [ ] **Step 2: Write tests with mock store**

Tests use the NoopEmbedder and a mock Mastra Memory instance (or test against a real Postgres if available via DATABASE_URL).

- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

```bash
git add src/agent/memory_mastra.ts src/agent/memory_mastra_test.ts
git commit -m "feat(memory): add MastraMemory implements MemoryPort"
```

---

### Task 12: Create memory factory

**Files:**
- Create: `src/agent/memory_factory.ts`

- [ ] **Step 1: Write factory functions**

```typescript
// src/agent/memory_factory.ts
import type { MemoryPort } from "./memory_port.ts";
import type { EmbedderPort } from "./embedder_port.ts";
import { Memory } from "./memory.ts";
import { log } from "../shared/log.ts";

export function createMemory(agentId: string, sessionId: string): MemoryPort {
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (dbUrl) {
    const embedder = createEmbedder();
    // Dynamic import to avoid loading @mastra/* when not needed
    return createMastraMemory(agentId, sessionId, dbUrl, embedder);
  }
  return new Memory(sessionId);
}

export function createEmbedder(): EmbedderPort {
  const provider = Deno.env.get("EMBEDDER_PROVIDER") ?? "fastembed";
  if (provider === "ollama") {
    const { OllamaEmbedder } = await import("./embedders/ollama.ts");
    return new OllamaEmbedder(
      Deno.env.get("OLLAMA_EMBED_URL")!,
      Deno.env.get("OLLAMA_EMBED_MODEL"),
    );
  }
  const { MastraEmbedder } = await import("./embedders/mastra.ts");
  return new MastraEmbedder();
}

async function createMastraMemory(
  agentId: string,
  sessionId: string,
  connectionString: string,
  embedder: EmbedderPort,
): Promise<MemoryPort> {
  const { MastraMemory } = await import("./memory_mastra.ts");
  return new MastraMemory(agentId, sessionId, { connectionString, embedder });
}
```

Note: the factory uses dynamic imports so @mastra/* is never loaded unless DATABASE_URL is set.

- [ ] **Step 2: Commit**

```bash
git add src/agent/memory_factory.ts
git commit -m "feat(memory): add createMemory + createEmbedder factory"
```

---

## Phase 4: Wire into loop.ts / runtime.ts

### Task 13: Update exports + deno.json

**Files:**
- Modify: `src/agent/mod.ts`
- Modify: `deno.json`

- [ ] **Step 1: Add Mastra exports to mod.ts**

```typescript
// Add to mod.ts
export type { EmbedderPort } from "./embedder_port.ts";
export { createMemory, createEmbedder } from "./memory_factory.ts";
```

- [ ] **Step 2: Add Mastra deps to deno.json imports**

```json
"@mastra/memory": "npm:@mastra/memory@^0",
"@mastra/pg": "npm:@mastra/pg@^0",
"@mastra/fastembed": "npm:@mastra/fastembed@^0"
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/mod.ts deno.json
git commit -m "feat(memory): export Mastra types + add npm deps"
```

---

### Task 14: Full verification

- [ ] **Step 1: Run lint**

Run: `deno task lint`

- [ ] **Step 2: Run type-check**

Run: `deno task check`

- [ ] **Step 3: Run full test suite**

Run: `deno task test`

- [ ] **Step 4: Final commit if any fixups needed**

---

## Summary

| Phase | Tasks | Key change |
|---|---|---|
| 1 (breaking) | 1-8 | Async MemoryPort + messages out of kernel → into llmMiddleware |
| 2 (additive) | 9-10 | EmbedderPort + 3 implementations |
| 3 (additive) | 11-12 | MastraMemory + factory |
| 4 (wiring) | 13-14 | Exports + deps + verification |
