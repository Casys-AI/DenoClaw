# Mastra Memory — Async MemoryPort + Vector Search + Embedder DI

Date: 2026-04-02
Status: design approved

## Summary

Migrate DenoClaw's agent memory to `@mastra/memory` with Postgres persistence
and pgvector semantic recall. Make `MemoryPort.getMessages()` async. Move
message assembly from the kernel to the `llmMiddleware` (fixes stale messages).
Add an `EmbedderPort` abstraction for DI (Ollama local, OpenAI deploy).

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| MemoryPort | Keep interface, make async | DI + testability, no vendor lock-in |
| Mastra integration | `MastraMemory implements MemoryPort` | Production impl, Mastra handles threads + vector |
| Kernel getMessages | Async (`Promise<Message[]>`) | Enables DB-backed + vector-enriched context |
| Message assembly | Moved from kernel to llmMiddleware | Fixes stale messages permanently |
| Embedder | `EmbedderPort` — Mastra native local, Ollama cloud / OpenAI for deploy | FFI works locally (fastembed), HTTP for Deploy (no FFI) |
| Postgres | Same instance as analytics (sub-project A) | Single DB, Mastra PgStore + PgVector |
| Legacy Memory/KvdexMemory | Kept, adapted to async | Backward compat for local dev without Postgres |

## Architecture

```
MemoryPort (async interface)
    │
    ├── MastraMemory ── @mastra/memory (PgStore + PgVector + EmbedderPort)
    ├── Memory ── Deno KV (legacy, adapted async)
    └── KvdexMemory ── kvdex (legacy, adapted async)

EmbedderPort (interface)
    │
    ├── MastraEmbedder ── @mastra/fastembed (local, FFI/ONNX)
    ├── OllamaEmbedder ── HTTP /api/embeddings (cloud Ollama instance)
    ├── OpenAIEmbedder ── HTTP /v1/embeddings (cloud)
    └── NoopEmbedder ── (tests, returns zero vectors)

Kernel ─yield→ LlmRequestEvent (no messages) ─pipeline→ llmMiddleware
                                                          │
                                                  await getMessages()
                                                  (async, post-refresh)
                                                          │
                                                    LLM call with
                                                    fresh context
```

## Breaking changes

### 1. MemoryPort becomes async

```typescript
// BEFORE
getMessages(): Message[];
getRecentMessages(count: number): Message[];

// AFTER
getMessages(): Promise<Message[]>;
getRecentMessages(count: number): Promise<Message[]>;
```

All consumers of `getMessages()` must `await`. This affects: kernel, runner
factories, loop.ts, runtime.ts, tests.

### 2. MemoryPort API additions

```typescript
// NEW: semantic vector search
semanticRecall(query: string, topK?: number): Promise<Message[]>;

// RENAME: avoid collision with semanticRecall
recallTopic(topic: string, limit?: number): Promise<LongTermFact[]>;
// was: recall(topic, limit?)
```

### 3. KernelInput.getMessages becomes async

```typescript
// BEFORE
getMessages: () => Message[];

// AFTER
getMessages: () => Promise<Message[]>;
```

### 4. LlmRequestEvent loses messages field

```typescript
// BEFORE
interface LlmRequestEvent extends BaseEvent {
  type: "llm_request";
  messages: Message[];   // baked at kernel yield time (stale)
  tools: ToolDefinition[];
  config: AgentConfig;
}

// AFTER
interface LlmRequestEvent extends BaseEvent {
  type: "llm_request";
  tools: ToolDefinition[];
  config: AgentConfig;
}
```

Messages are assembled by `llmMiddleware` at execution time (after context
refresh), not baked by the kernel. This permanently fixes the stale messages
issue from the Kaku review.

### 5. llmMiddleware assembles messages

```typescript
// BEFORE: llmMiddleware receives CompleteFn, ignores event messages
llmMiddleware((_msgs, model, temp, maxTok, tools) =>
  deps.complete(getMessages(), model, temp, maxTok, tools)
)

// AFTER: llmMiddleware receives getMessages + CompleteFn separately
llmMiddleware({ getMessages, complete })
// Middleware calls: const messages = await getMessages();
//                   const response = await complete(messages, model, ...);
```

## MemoryPort v2

```typescript
export interface MemoryPort {
  load(): Promise<void>;
  close(): void;

  // Conversations (now async)
  addMessage(message: Message): Promise<void>;
  getMessages(): Promise<Message[]>;
  getRecentMessages(count: number): Promise<Message[]>;
  clear(): Promise<void>;
  readonly count: number;

  // Semantic search (new)
  semanticRecall(query: string, topK?: number): Promise<Message[]>;

  // Long-term facts (renamed recall → recallTopic)
  remember(fact: Omit<LongTermFact, "timestamp">): Promise<void>;
  recallTopic(topic: string, limit?: number): Promise<LongTermFact[]>;
  listTopics(): Promise<string[]>;
  forgetTopic(topic: string): Promise<void>;
}
```

### Legacy adapters

`Memory` and `KvdexMemory` get trivial async wrappers:

```typescript
// Memory (KV-backed)
async getMessages(): Promise<Message[]> {
  return this.#messages;  // was synchronous, now returns Promise
}

async semanticRecall(): Promise<Message[]> {
  return [];  // no vector search in legacy impl
}

async recallTopic(topic: string, limit?: number): Promise<LongTermFact[]> {
  return this.recall(topic, limit);  // rename
}
```

No behavioral change — just type signature update.

## MastraMemory

### Implementation

```typescript
import { Memory } from "@mastra/memory";
import { PgStore, PgVector } from "@mastra/pg";
import type { Message } from "../shared/types.ts";
import type { MemoryPort, LongTermFact } from "./memory_port.ts";
import type { EmbedderPort } from "./embedder_port.ts";

export class MastraMemory implements MemoryPort {
  private mastra: Memory;
  private threadId: string;
  private messageCount = 0;

  constructor(
    agentId: string,
    sessionId: string,
    config: {
      connectionString: string;
      embedder: EmbedderPort;
      lastMessages?: number;
      semanticRecall?: { topK: number; messageRange: number };
    },
  ) {
    this.threadId = `${agentId}:${sessionId}`;
    this.mastra = new Memory({
      storage: new PgStore({
        id: `denoclaw-${agentId}`,
        connectionString: config.connectionString,
      }),
      vector: new PgVector({
        id: `denoclaw-${agentId}-vec`,
        connectionString: config.connectionString,
      }),
      embedder: toMastraEmbedder(config.embedder),
      options: {
        lastMessages: config.lastMessages ?? 50,
        semanticRecall: config.semanticRecall ?? {
          topK: 3,
          messageRange: 2,
        },
      },
    });
  }

  async load(): Promise<void> {
    // Ensure thread exists
    const existing = await this.mastra.getThreadById({ threadId: this.threadId });
    if (!existing) {
      await this.mastra.createThread({ threadId: this.threadId });
    }
  }

  close(): void {
    // PgStore connection pool handles cleanup
  }

  async addMessage(message: Message): Promise<void> {
    await this.mastra.saveMessages({
      threadId: this.threadId,
      messages: [toMastraMessage(message)],
    });
    this.messageCount++;
  }

  async getMessages(): Promise<Message[]> {
    const result = await this.mastra.recall({ threadId: this.threadId });
    return result.messages.map(fromMastraMessage);
  }

  async getRecentMessages(count: number): Promise<Message[]> {
    const result = await this.mastra.recall({
      threadId: this.threadId,
      perPage: count,
    });
    return result.messages.map(fromMastraMessage);
  }

  get count(): number {
    return this.messageCount;
  }

  async clear(): Promise<void> {
    await this.mastra.deleteThread({ threadId: this.threadId });
    await this.mastra.createThread({ threadId: this.threadId });
    this.messageCount = 0;
  }

  async semanticRecall(query: string, topK = 3): Promise<Message[]> {
    const result = await this.mastra.recall({
      threadId: this.threadId,
      vectorSearchString: query,
      threadConfig: {
        semanticRecall: { topK, messageRange: 2 },
      },
    });
    return result.messages.map(fromMastraMessage);
  }

  // Long-term facts — stored as special messages or via working memory
  async remember(fact: Omit<LongTermFact, "timestamp">): Promise<void> {
    await this.addMessage({
      role: "system",
      content: `[memory:${fact.topic}] ${fact.content}`,
    });
  }

  async recallTopic(topic: string): Promise<LongTermFact[]> {
    const messages = await this.semanticRecall(`topic: ${topic}`, 5);
    return messages
      .filter((m) => m.content.startsWith(`[memory:${topic}]`))
      .map((m) => ({
        topic,
        content: m.content.replace(`[memory:${topic}] `, ""),
        timestamp: new Date().toISOString(),
      }));
  }

  async listTopics(): Promise<string[]> {
    const messages = await this.getMessages();
    const topics = new Set<string>();
    for (const m of messages) {
      const match = m.content.match(/^\[memory:([^\]]+)\]/);
      if (match) topics.add(match[1]);
    }
    return [...topics];
  }

  async forgetTopic(_topic: string): Promise<void> {
    // Mastra doesn't support deleting individual messages in v1
    // Mark as forgotten in working memory instead
  }
}
```

### Message mapping

```typescript
function toMastraMessage(msg: Message): MastraMessage {
  return {
    role: msg.role === "tool" ? "tool" : msg.role,
    content: msg.content,
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.tool_call_id ? { toolCallId: msg.tool_call_id } : {}),
    ...(msg.tool_calls ? { toolCalls: msg.tool_calls } : {}),
  };
}

function fromMastraMessage(msg: MastraMessage): Message {
  return {
    role: msg.role as Message["role"],
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
  };
}
```

## EmbedderPort

```typescript
// src/agent/embedder_port.ts

export interface EmbedderPort {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly modelName: string;
}
```

### MastraEmbedder (local default)

```typescript
// src/agent/embedders/mastra.ts
// Uses @mastra/fastembed — local ONNX inference, no external service needed.
// Requires FFI (works on local Deno, NOT on Deno Deploy).

import { fastembed } from "@mastra/fastembed";

export class MastraEmbedder implements EmbedderPort {
  readonly dimension = 384;
  readonly modelName = "fastembed";

  async embed(text: string): Promise<number[]> {
    const result = await fastembed.embed([text]);
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const result = await fastembed.embed(texts);
    return result.embeddings;
  }
}
```

### OllamaEmbedder (cloud)

```typescript
// src/agent/embedders/ollama.ts
// Connects to a cloud-hosted Ollama instance via HTTP.
// Use for Deno Deploy or any environment without FFI.
// API: POST /api/embed — input: string | string[], response: { embeddings: number[][] }

export class OllamaEmbedder implements EmbedderPort {
  readonly dimension: number;
  readonly modelName: string;

  constructor(
    private baseUrl: string,  // e.g. "https://ollama.myinfra.com"
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

### OpenAIEmbedder (cloud)

```typescript
// src/agent/embedders/openai.ts
// Standard OpenAI embeddings API. Alternative to cloud Ollama.

export class OpenAIEmbedder implements EmbedderPort {
  readonly dimension = 1536;
  readonly modelName: string;

  constructor(
    private apiKey: string,
    model = "text-embedding-3-small",
  ) {
    this.modelName = model;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.modelName, input: text }),
    });
    if (!res.ok) throw new Error(`OpenAI embed failed: ${res.status}`);
    const body = await res.json();
    return body.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI embed batch failed: ${res.status}`);
    const body = await res.json();
    return body.data.map((d: { embedding: number[] }) => d.embedding);
  }
}
```

### Mastra embedder adapter

```typescript
// Bridge EmbedderPort → Mastra's expected embedder interface
function toMastraEmbedder(port: EmbedderPort) {
  return {
    embed: async (texts: string[]) => {
      const embeddings = await port.embedBatch(texts);
      return { embeddings };
    },
    dimensions: port.dimension,
  };
}
```

## Kernel changes

### LlmRequestEvent — remove messages

```typescript
export interface LlmRequestEvent extends BaseEvent {
  type: "llm_request";
  // messages removed — assembled by llmMiddleware post-refresh
  tools: ToolDefinition[];
  config: AgentConfig;
}
```

### Kernel — no longer calls getMessages

```typescript
export async function* agentKernel(
  input: KernelInput,
): AsyncGenerator<AgentEvent, FinalEvent, EventResolution | undefined> {
  // ...
  while (iteration < input.maxIterations) {
    iteration++;

    // Yield LLM request intent — middleware assembles messages
    const llmResolution = (yield event<AgentEvent>(
      {
        type: "llm_request",
        tools: input.toolDefinitions,
        config: input.llmConfig,
      },
      iteration,
    )) as LlmResolution;
    // ...
  }
}
```

### KernelInput — simplified

```typescript
export interface KernelInput {
  // getMessages removed — handled by llmMiddleware
  toolDefinitions: ToolDefinition[];
  llmConfig: AgentConfig;
  maxIterations: number;
}
```

## llmMiddleware changes

```typescript
export interface LlmMiddlewareDeps {
  getMessages: () => Promise<Message[]>;
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
    return {
      type: "llm",
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      usage: response.usage,
    } as LlmResolution;
  };
}
```

## Runner factory changes

`buildMessages` becomes async. `getMessages` is no longer in `KernelInput` —
it's passed to `llmMiddleware` directly.

```typescript
export interface LocalRunnerDeps {
  // ... same fields ...
  buildMessages: (
    memoryTopics: string[],
    memoryFiles: string[],
  ) => Promise<Message[]>;  // NOW ASYNC
  // getMessages removed from KernelInput deps
}

export function createLocalRunner(deps: LocalRunnerDeps): RunnerBundle {
  const session = { ... };

  const getMessages = () =>
    deps.buildMessages(session.memoryTopics, session.memoryFiles);

  const pipeline = new MiddlewarePipeline()
    .use(observabilityMiddleware(deps.observability))
    .use(memoryMiddleware(deps.memory))
    .use(contextRefreshMiddleware(deps.contextRefresh))
    .use(toolMiddleware(deps.executeTool))
    .use(llmMiddleware({ getMessages, complete: deps.complete }));

  return {
    runner: new AgentRunner(pipeline, new InMemoryEventStore(), session, deps.memory),
    session,
    kernelInput: {
      toolDefinitions: deps.toolDefinitions,
      llmConfig: deps.llmConfig,
      maxIterations: deps.maxIterations,
    },
  };
}
```

## Configuration

### Environment variables

```
# Mastra memory (opt-in — falls back to KV if absent)
DATABASE_URL=postgresql://denoclaw:denoclaw@localhost:5432/denoclaw

# Embedder (opt-in — defaults to fastembed local if DATABASE_URL is set)
# EMBEDDER_PROVIDER=fastembed     # local default (FFI/ONNX, no external service)
# EMBEDDER_PROVIDER=ollama        # cloud Ollama instance (for Deploy)
# EMBEDDER_PROVIDER=openai        # OpenAI API (for Deploy)
# OLLAMA_URL=https://ollama.myinfra.com  # required for ollama provider
# OPENAI_API_KEY=sk-...                  # required for openai provider
```

### Factory selection

```typescript
function createMemory(agentId: string, sessionId: string): MemoryPort {
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (dbUrl) {
    const embedder = createEmbedder();
    return new MastraMemory(agentId, sessionId, {
      connectionString: dbUrl,
      embedder,
    });
  }
  // Fallback: legacy KV memory
  return new Memory(sessionId);
}

function createEmbedder(): EmbedderPort {
  const provider = Deno.env.get("EMBEDDER_PROVIDER") ?? "fastembed";
  switch (provider) {
    case "ollama":
      return new OllamaEmbedder(
        Deno.env.get("OLLAMA_URL")!,
        Deno.env.get("EMBEDDER_MODEL"),
      );
    case "openai":
      return new OpenAIEmbedder(Deno.env.get("OPENAI_API_KEY")!);
    default:
      // Local: Mastra fastembed (ONNX, no external service)
      return new MastraEmbedder();
  }
}
```

## New files

| File | Content |
|---|---|
| `src/agent/memory_mastra.ts` | MastraMemory implements MemoryPort |
| `src/agent/memory_mastra_test.ts` | Tests with mock Mastra |
| `src/agent/embedder_port.ts` | EmbedderPort interface |
| `src/agent/embedders/mastra.ts` | MastraEmbedder (local default, fastembed) |
| `src/agent/embedders/ollama.ts` | OllamaEmbedder (cloud Ollama) |
| `src/agent/embedders/openai.ts` | OpenAIEmbedder (cloud) |
| `src/agent/embedders/noop.ts` | NoopEmbedder (tests) |
| `src/agent/embedders/ollama_test.ts` | Test with mock HTTP |
| `src/agent/memory_factory.ts` | createMemory() + createEmbedder() |

## Modified files

| File | Change |
|---|---|
| `src/agent/memory_port.ts` | getMessages async, add semanticRecall, rename recall→recallTopic |
| `src/agent/memory.ts` | Wrap sync methods in Promise |
| `src/agent/memory_kvdex.ts` | Wrap sync methods in Promise |
| `src/agent/events.ts` | Remove messages from LlmRequestEvent |
| `src/agent/kernel.ts` | Remove getMessages call, simplify KernelInput |
| `src/agent/middlewares/llm.ts` | Accept LlmMiddlewareDeps, call getMessages async |
| `src/agent/runner.ts` | Adapt factories: buildMessages async, remove getMessages from KernelInput |
| `src/agent/loop.ts` | Adapt for async MemoryPort, pass getMessages to llm deps |
| `src/agent/runtime.ts` | Adapt for async MemoryPort |
| `src/agent/tools/memory.ts` | Adapt MemoryTool for rename (recallTopic) |
| `src/agent/mod.ts` | Export new types |
| `deno.json` | Add @mastra/memory, @mastra/pg |
| All test files with FakeMemory/MemoryStub | Adapt to async |

## What does NOT change

- `observabilityMiddleware` — intact
- `contextRefreshMiddleware` — intact (still mutates session.memoryTopics/Files)
- `a2aTaskMiddleware` — intact
- `toolMiddleware` — intact
- `analyticsMiddleware` — intact
- Dashboard, broker, federation — intact
- .md memory files — intact (long-term memory files are orthogonal)

## Migration path

1. Phase 1: Make MemoryPort async + adapt all consumers (no Mastra yet)
2. Phase 2: Add EmbedderPort + Ollama/OpenAI implementations
3. Phase 3: Add MastraMemory implementation + factory
4. Phase 4: Wire into loop.ts / runtime.ts with DATABASE_URL opt-in

Each phase is independently deployable. Phase 1 is the breaking change;
phases 2-4 are additive.

## Future extensions (not in this iteration)

- **Working memory** (Mastra's structured user profile template)
- **Thread management UI** in dashboard (list, inspect, delete conversations)
- **Cross-session recall** (search across all threads for an agent)
- **Embedding cost tracking** via analyticsMiddleware
- **fastembed for local** when Deno FFI is stable on Deploy
