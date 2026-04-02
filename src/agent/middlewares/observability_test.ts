import { assertEquals } from "@std/assert";
import { observabilityMiddleware } from "./observability.ts";
import type { SessionState } from "../middleware.ts";
import type { TraceCorrelationIds } from "../../telemetry/traces.ts";

class RecordingTraceWriter {
  calls: Array<{ method: string; args: unknown[] }> = [];
  traceStarted = false;

  startTrace(agentId: string, sessionId: string, ids: TraceCorrelationIds = {}): Promise<string> {
    this.calls.push({ method: "startTrace", args: [agentId, sessionId, ids] });
    this.traceStarted = true;
    return Promise.resolve("trace-1");
  }
  endTrace(traceId: string, status: string, iterations: number): Promise<void> {
    this.calls.push({ method: "endTrace", args: [traceId, status, iterations] });
    return Promise.resolve();
  }
  writeIterationSpan(traceId: string, agentId: string, iteration: number): Promise<string> {
    this.calls.push({ method: "writeIterationSpan", args: [traceId, agentId, iteration] });
    return Promise.resolve(`iter-${iteration}`);
  }
  writeLLMSpan(traceId: string, _agentId: string, _parentSpanId: string, model: string): Promise<string> {
    this.calls.push({ method: "writeLLMSpan", args: [traceId, model] });
    return Promise.resolve("llm-span");
  }
  writeToolSpan(traceId: string, _agentId: string, _parentSpanId: string, tool: string, success: boolean): Promise<string> {
    this.calls.push({ method: "writeToolSpan", args: [traceId, tool, success] });
    return Promise.resolve("tool-span");
  }
  endSpan(traceId: string, spanId: string, duration: number): Promise<void> {
    this.calls.push({ method: "endSpan", args: [traceId, spanId, duration] });
    return Promise.resolve();
  }
}

function makeSession(): SessionState {
  return { agentId: "agent-1", sessionId: "sess-1", memoryFiles: [] };
}

Deno.test("observabilityMiddleware starts trace on first event", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request" as const,  tools: [], config: { model: "test/m" },
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));
  assertEquals(writer.traceStarted, true);
  const startCall = writer.calls.find((c) => c.method === "startTrace");
  assertEquals(startCall?.args[0], "agent-1");
});

Deno.test("observabilityMiddleware writes LLM span on llm_response", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  // First: trigger trace start with llm_request
  await mw(
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request",  tools: [], config: { model: "test/m" } }, session: makeSession() },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  // Then: llm_response observation
  await mw(
    { event: { eventId: 1, timestamp: Date.now(), iterationId: 1, type: "llm_response", content: "hello", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }, session: makeSession() },
    () => Promise.resolve(undefined),
  );
  const llmCall = writer.calls.find((c) => c.method === "writeLLMSpan");
  assertEquals(llmCall !== undefined, true);
});

Deno.test("observabilityMiddleware ends trace on complete event", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  const session = makeSession();
  // Start trace
  await mw(
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request",  tools: [], config: { model: "m" } }, session },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  // Complete
  await mw(
    { event: { eventId: 2, timestamp: Date.now(), iterationId: 1, type: "complete", content: "done" }, session },
    () => Promise.resolve(undefined),
  );
  const endCall = writer.calls.find((c) => c.method === "endTrace");
  assertEquals(endCall !== undefined, true);
  assertEquals(endCall?.args[1], "completed");
});

Deno.test("observabilityMiddleware works without traceWriter (no-op)", async () => {
  const mw = observabilityMiddleware({
    traceWriter: null, agentId: "a", sessionId: "s", correlationIds: {},
  });
  const result = await mw(
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request",  tools: [], config: { model: "m" } }, session: makeSession() },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  assertEquals(result?.type, "llm");
});

Deno.test("observabilityMiddleware writes tool span on tool_call", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  const session = makeSession();
  // Start trace via llm_request
  await mw(
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request",  tools: [], config: { model: "m" } }, session },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  // tool_call
  await mw(
    { event: { eventId: 2, timestamp: Date.now(), iterationId: 1, type: "tool_call", callId: "tc1", name: "shell", arguments: { cmd: "ls" } }, session },
    () => Promise.resolve({ type: "tool" as const, result: { success: true, output: "ok" } }),
  );
  const toolCall = writer.calls.find((c) => c.method === "writeToolSpan");
  assertEquals(toolCall !== undefined, true);
});

Deno.test("observabilityMiddleware ends trace with failed on error event", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  const session = makeSession();
  await mw(
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request",  tools: [], config: { model: "m" } }, session },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  await mw(
    { event: { eventId: 2, timestamp: Date.now(), iterationId: 1, type: "error", code: "max_iterations", recovery: "try again" }, session },
    () => Promise.resolve(undefined),
  );
  const endCall = writer.calls.find((c) => c.method === "endTrace");
  assertEquals(endCall?.args[1], "failed");
});

Deno.test("observabilityMiddleware handles iteration span transitions", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  const session = makeSession();
  // Iteration 1
  await mw(
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request",  tools: [], config: { model: "m" } }, session },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  // Iteration 2 - should end iter 1 span and start iter 2
  await mw(
    { event: { eventId: 3, timestamp: Date.now(), iterationId: 2, type: "llm_request",  tools: [], config: { model: "m" } }, session },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  const iterCalls = writer.calls.filter((c) => c.method === "writeIterationSpan");
  assertEquals(iterCalls.length, 2);
  const endSpanCalls = writer.calls.filter((c) => c.method === "endSpan");
  assertEquals(endSpanCalls.length >= 1, true);
});
