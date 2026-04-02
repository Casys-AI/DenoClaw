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
  endSpan(): Promise<void> { return Promise.resolve(); }
}

function makeSession(): SessionState {
  return { agentId: "agent-1", sessionId: "sess-1", memoryTopics: [], memoryFiles: [], currentIteration: 0 };
}

Deno.test("observabilityMiddleware starts trace on first event", async () => {
  const writer = new RecordingTraceWriter();
  const mw = observabilityMiddleware({
    traceWriter: writer as never, agentId: "agent-1", sessionId: "sess-1", correlationIds: {},
  });
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request" as const, messages: [], tools: [], config: { model: "test/m" },
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
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request", messages: [], tools: [], config: { model: "test/m" } }, session: makeSession() },
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
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request", messages: [], tools: [], config: { model: "m" } }, session },
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
    { event: { eventId: 0, timestamp: Date.now(), iterationId: 1, type: "llm_request", messages: [], tools: [], config: { model: "m" } }, session: makeSession() },
    () => Promise.resolve({ type: "llm" as const, content: "ok" }),
  );
  assertEquals(result?.type, "llm");
});
