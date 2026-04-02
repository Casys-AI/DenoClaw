import { assertEquals } from "@std/assert";
import { llmMiddleware } from "./llm.ts";
import type { LlmRequestEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";

function makeSession(): SessionState {
  return { agentId: "a", sessionId: "s", memoryTopics: [], memoryFiles: [] };
}

Deno.test("llmMiddleware resolves llm_request events", async () => {
  const completeFn = (
    _messages: unknown[], _model: string,
  ) => Promise.resolve({
    content: "response", toolCalls: [], finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });
  const mw = llmMiddleware(completeFn);
  const event: LlmRequestEvent = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request", messages: [{ role: "user", content: "hi" }],
    tools: [], config: { model: "test/m" },
  };
  const result = await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(result?.type, "llm");
  if (result?.type === "llm") assertEquals(result.content, "response");
});

Deno.test("llmMiddleware passes through non-llm_request events", async () => {
  const completeFn = () => { throw new Error("should not be called"); };
  const mw = llmMiddleware(completeFn);
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "tool_call" as const, callId: "c1", name: "shell", arguments: {},
  };
  const nextResult = { type: "tool" as const, result: { success: true, output: "ok" } };
  const result = await mw({ event, session: makeSession() }, () => Promise.resolve(nextResult));
  assertEquals(result, nextResult);
});
