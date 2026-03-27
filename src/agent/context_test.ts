import { assertEquals, assertStringIncludes } from "@std/assert";
import { ContextBuilder } from "./context.ts";
import type { Message } from "../shared/types.ts";

const builder = new ContextBuilder({
  model: "test",
  temperature: 0.5,
  maxTokens: 1024,
});

Deno.test("buildSystemPrompt includes default prompt when no custom one", () => {
  const prompt = builder.buildSystemPrompt([], []);
  assertStringIncludes(prompt, "DenoClaw");
  assertStringIncludes(prompt, "Current time:");
});

Deno.test("buildSystemPrompt includes skills", () => {
  const prompt = builder.buildSystemPrompt(
    [{ name: "TestSkill", description: "A test", content: "", path: "" }],
    [],
  );
  assertStringIncludes(prompt, "TestSkill");
  assertStringIncludes(prompt, "A test");
});

Deno.test("buildSystemPrompt includes tools", () => {
  const prompt = builder.buildSystemPrompt([], [{
    type: "function",
    function: {
      name: "test_tool",
      description: "Does testing",
      parameters: { type: "object", properties: {} },
    },
  }]);
  assertStringIncludes(prompt, "test_tool");
  assertStringIncludes(prompt, "Does testing");
});

Deno.test("truncateContext keeps all messages when under limit", () => {
  const msgs: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ];
  const result = builder.truncateContext(msgs, 10000);
  assertEquals(result.length, 2);
});

Deno.test("truncateContext drops old messages when over limit", () => {
  const msgs: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "recent" },
  ];
  const result = builder.truncateContext(msgs, 20);
  assertEquals(result[0].role, "system");
  assertEquals(result.at(-1)?.content, "recent");
});

Deno.test("buildContextMessages prepends system message", () => {
  const msgs: Message[] = [{ role: "user", content: "hi" }];
  const result = builder.buildContextMessages(msgs, [], []);
  assertEquals(result[0].role, "system");
  assertEquals(result[1].role, "user");
});
