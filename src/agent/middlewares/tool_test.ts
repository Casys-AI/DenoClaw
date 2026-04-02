import { assertEquals } from "@std/assert";
import { toolMiddleware } from "./tool.ts";
import type { ToolCallEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";
import type { ToolResult } from "../../shared/types.ts";

function makeSession(): SessionState {
  return { agentId: "a", sessionId: "s", memoryTopics: [], memoryFiles: [] };
}

Deno.test("toolMiddleware resolves tool_call events", async () => {
  const executeFn = (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    assertEquals(name, "shell");
    assertEquals(args, { command: "ls" });
    return Promise.resolve({ success: true, output: "file.txt" });
  };
  const mw = toolMiddleware(executeFn);
  const event: ToolCallEvent = {
    eventId: 2, timestamp: Date.now(), iterationId: 1,
    type: "tool_call", callId: "tc1", name: "shell", arguments: { command: "ls" },
  };
  const result = await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(result?.type, "tool");
  if (result?.type === "tool") assertEquals(result.result.output, "file.txt");
});

Deno.test("toolMiddleware passes through non-tool_call events", async () => {
  const executeFn = () => { throw new Error("should not be called"); };
  const mw = toolMiddleware(executeFn);
  const event = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request" as const, messages: [], tools: [], config: { model: "m" },
  };
  const nextResult = { type: "llm" as const, content: "ok" };
  const result = await mw({ event, session: makeSession() }, () => Promise.resolve(nextResult));
  assertEquals(result, nextResult);
});
