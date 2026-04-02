import { assertEquals } from "@std/assert";
import { agentKernel } from "./kernel.ts";
import type { KernelInput } from "./kernel.ts";
import type {
  CompleteEvent,
  ErrorEvent,
  LlmRequestEvent,
  LlmResolution,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResolution,
  ToolResultEvent,
} from "./events.ts";

function makeInput(overrides?: Partial<KernelInput>): KernelInput {
  return {
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
  const completeEvent = step3.value as CompleteEvent;
  assertEquals(completeEvent.type, "complete");
  assertEquals(completeEvent.content, "Hello back!");
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

  // Pass undefined for observation -> kernel loops to next iteration (llm_request)
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
  await kernel.next({
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
  await kernel.next({ type: "tool", result: { success: true, output: "ok" } } as ToolResolution);

  // tool_result observation — this next() triggers continue, hits while(1<1)=false, returns error
  const final = await kernel.next(undefined);
  assertEquals(final.done, true);
  assertEquals(final.value.type, "error");
  assertEquals((final.value as ErrorEvent).code, "max_iterations");
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
