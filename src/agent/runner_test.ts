import { assertEquals } from "@std/assert";
import { AgentRunner, createLocalRunner } from "./runner.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import { InMemoryEventStore } from "./event_store.ts";
import type { LlmResolution, LlmResponseEvent, ToolResultEvent } from "./events.ts";
import { memoryMiddleware } from "./middlewares/memory.ts";
import type { Message } from "../shared/types.ts";

class StubMemory {
  messages: Message[] = [];
  addMessage(msg: Message): Promise<void> {
    this.messages.push(msg);
    return Promise.resolve();
  }
  getMessages(): Promise<Message[]> {
    return Promise.resolve([...this.messages]);
  }
}

function makeSession(): SessionState {
  return {
    agentId: "agent-1", sessionId: "sess-1",
    memoryFiles: [],
  };
}

Deno.test("AgentRunner orchestrates kernel + pipeline to completion", async () => {
  const pipeline = new MiddlewarePipeline();
  // LLM middleware: returns text-only response
  pipeline.use((ctx, next) => {
    if (ctx.event.type === "llm_request") {
      return Promise.resolve({ type: "llm" as const, content: "Hello!", finishReason: "stop" } as LlmResolution);
    }
    return next();
  });

  const store = new InMemoryEventStore();
  const memory = new StubMemory();
  const runner = new AgentRunner(pipeline, store, makeSession(), memory);
  const result = await runner.run({
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

  // Memory middleware (to persist messages for getMessages)
  pipeline.use(async (ctx, next) => {
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      if (e.toolCalls?.length) {
        await memory.addMessage({ role: "assistant", content: e.content || "", tool_calls: e.toolCalls });
      } else {
        await memory.addMessage({ role: "assistant", content: e.content });
      }
    }
    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      await memory.addMessage({ role: "tool", content: e.result.output, name: e.name, tool_call_id: e.callId });
    }
    return next();
  });

  // LLM middleware
  pipeline.use((ctx, next) => {
    if (ctx.event.type === "llm_request") {
      llmCalls++;
      if (llmCalls === 1) {
        return Promise.resolve({
          type: "llm" as const, content: "",
          toolCalls: [{ id: "tc1", type: "function" as const, function: { name: "shell", arguments: '{"command":"ls"}' } }],
        });
      }
      return Promise.resolve({ type: "llm" as const, content: "Done!", finishReason: "stop" });
    }
    return next();
  });
  // Tool middleware
  pipeline.use((ctx, next) => {
    if (ctx.event.type === "tool_call") {
      return Promise.resolve({ type: "tool" as const, result: { success: true, output: "file.txt" } });
    }
    return next();
  });

  const memory = new StubMemory();
  const runner = new AgentRunner(pipeline, new InMemoryEventStore(), makeSession(), memory);
  const result = await runner.run({
    toolDefinitions: [],
    llmConfig: { model: "test" },
    maxIterations: 5,
  });

  assertEquals(result.content, "Done!");
  assertEquals(llmCalls, 2);
});

Deno.test("AgentRunner returns last assistant message on max_iterations", async () => {
  const memory = new StubMemory();
  const pipeline = new MiddlewarePipeline();

  pipeline.use(memoryMiddleware(memory));

  // Always return tool calls (forces looping until max_iterations)
  pipeline.use((ctx, next) => {
    if (ctx.event.type === "llm_request") {
      return Promise.resolve({
        type: "llm" as const, content: "still thinking...",
        toolCalls: [{ id: "tc", type: "function" as const, function: { name: "shell", arguments: '{"command":"ls"}' } }],
      });
    }
    return next();
  });
  pipeline.use((ctx, next) => {
    if (ctx.event.type === "tool_call") {
      return Promise.resolve({ type: "tool" as const, result: { success: true, output: "ok" } });
    }
    return next();
  });

  const runner = new AgentRunner(pipeline, new InMemoryEventStore(), makeSession(), memory);
  const result = await runner.run({
    toolDefinitions: [],
    llmConfig: { model: "test" },
    maxIterations: 1,
  });

  assertEquals(result.finishReason, "max_iterations");
  assertEquals(result.content, "still thinking...");
});

Deno.test("createLocalRunner works when analytics are explicitly disabled", async () => {
  const memory = new StubMemory();
  const { runner, kernelInput } = createLocalRunner({
    agentId: "agent-1",
    sessionId: "sess-1",
    memoryFiles: [],
    memory,
    complete: () => Promise.resolve({
      content: "Hello from local runner",
      finishReason: "stop",
    }),
    executeTool: () => Promise.resolve({ success: true, output: "unused" }),
    observability: {
      traceWriter: null,
      agentId: "agent-1",
      sessionId: "sess-1",
      correlationIds: {},
    },
    contextRefresh: {
      skills: { reload: () => Promise.resolve() },
      refreshMemoryFiles: undefined,
    },
    analytics: null,
    buildMessages: () => Promise.resolve([{ role: "user", content: "hi" }]),
    toolDefinitions: [],
    llmConfig: { model: "test" },
    maxIterations: 3,
  });

  const result = await runner.run(kernelInput);
  assertEquals(result.content, "Hello from local runner");
});
