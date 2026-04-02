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
  const e1 = event({ type: "llm_request", tools: [], config: { model: "test" } }, 1);
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
    { type: "llm_request", tools: [], config: { model: "m" } },
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
