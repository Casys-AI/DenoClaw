import { assertEquals } from "@std/assert";
import { memoryMiddleware } from "./memory.ts";
import type { LlmResponseEvent, ToolResultEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";
import type { Message } from "../../shared/types.ts";

function makeSession(): SessionState {
  return { agentId: "a", sessionId: "s", memoryFiles: [] };
}

Deno.test("memoryMiddleware persists assistant message on llm_response with tool calls", async () => {
  const messages: Message[] = [];
  const memory = { addMessage: (msg: Message) => { messages.push(msg); return Promise.resolve(); } };
  const mw = memoryMiddleware(memory);
  const event: LlmResponseEvent = {
    eventId: 1, timestamp: Date.now(), iterationId: 1,
    type: "llm_response", content: "thinking...",
    toolCalls: [{ id: "tc1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } }],
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "assistant");
  assertEquals(messages[0].content, "thinking...");
  assertEquals(messages[0].tool_calls?.length, 1);
});

Deno.test("memoryMiddleware persists assistant message on llm_response without tool calls", async () => {
  const messages: Message[] = [];
  const memory = { addMessage: (msg: Message) => { messages.push(msg); return Promise.resolve(); } };
  const mw = memoryMiddleware(memory);
  const event: LlmResponseEvent = {
    eventId: 1, timestamp: Date.now(), iterationId: 1,
    type: "llm_response", content: "final answer",
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "assistant");
  assertEquals(messages[0].content, "final answer");
  assertEquals(messages[0].tool_calls, undefined);
});

Deno.test("memoryMiddleware persists tool result on tool_result", async () => {
  const messages: Message[] = [];
  const memory = { addMessage: (msg: Message) => { messages.push(msg); return Promise.resolve(); } };
  const mw = memoryMiddleware(memory);
  const event: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result", callId: "tc1", name: "shell",
    arguments: { command: "ls" }, result: { success: true, output: "file.txt" },
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
  const memory = { addMessage: (msg: Message) => { messages.push(msg); return Promise.resolve(); } };
  const mw = memoryMiddleware(memory);
  const event: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result", callId: "tc1", name: "shell", arguments: {},
    result: {
      success: false, output: "",
      error: { code: "DENIED", context: { reason: "policy" }, recovery: "check perms" },
    },
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(messages[0].content, 'Error [DENIED]: {"reason":"policy"}\nRecovery: check perms');
});
