import { assertEquals } from "@std/assert";
import { llmMiddleware } from "./llm.ts";
import type { SessionState } from "../middleware.ts";

function makeSession(): SessionState {
  return { agentId: "a", sessionId: "s", memoryFiles: [] };
}

Deno.test("llmMiddleware resolves llm_request events", async () => {
  const mw = llmMiddleware({
    getMessages: () => Promise.resolve([{ role: "user", content: "hi" }]),
    complete: () => Promise.resolve({
      content: "response", toolCalls: [], finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
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
  if (result?.type === "llm") assertEquals(result.content, "response");
});

Deno.test("llmMiddleware calls getMessages fresh on each invocation", async () => {
  let callCount = 0;
  const mw = llmMiddleware({
    getMessages: () => {
      callCount++;
      return Promise.resolve([{ role: "user" as const, content: "hi" }]);
    },
    complete: () =>
      Promise.resolve({
        content: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
  });
  const event = {
    eventId: 0,
    timestamp: Date.now(),
    iterationId: 1,
    type: "llm_request" as const,
    tools: [],
    config: { model: "m" },
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(callCount, 2);
});

Deno.test("llmMiddleware passes through non-llm_request events", async () => {
  const mw = llmMiddleware({
    getMessages: () => { throw new Error("should not be called"); },
    complete: () => { throw new Error("should not be called"); },
  });
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "tool_call" as const, callId: "c1", name: "shell", arguments: {},
  };
  const nextResult = { type: "tool" as const, result: { success: true, output: "ok" } };
  const result = await mw(
    { event, session: makeSession() },
    () => Promise.resolve(nextResult),
  );
  assertEquals(result, nextResult);
});
