import { assertEquals } from "@std/assert";
import { contextRefreshMiddleware } from "./context_refresh.ts";
import type { LlmRequestEvent, ToolResultEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";

function makeSession(): SessionState {
  return {
    agentId: "a", sessionId: "s",
    memoryFiles: ["old-file.md"],
  };
}

Deno.test("contextRefreshMiddleware reloads skills after write_file to skills/", async () => {
  let reloaded = false;
  const skills = { reload: () => { reloaded = true; return Promise.resolve(); } };
  const refreshFiles = () => Promise.resolve(["new.md"]);
  const mw = contextRefreshMiddleware({ skills, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result", callId: "tc1", name: "write_file",
    arguments: { path: "skills/new.md", content: "# Skill", dry_run: false },
    result: { success: true, output: "written" },
  };
  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  // Refresh happens on next llm_request
  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request",  tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));
  assertEquals(reloaded, true);
});

Deno.test("contextRefreshMiddleware reloads memory files after write_file to memories/", async () => {
  const skills = { reload: () => Promise.resolve() };
  const refreshFiles = () => Promise.resolve(["new-mem.md"]);
  const mw = contextRefreshMiddleware({ skills, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result", callId: "tc1", name: "write_file",
    arguments: { path: "memories/project.md", content: "# Mem", dry_run: false },
    result: { success: true, output: "written" },
  };
  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request",  tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));
  assertEquals(session.memoryFiles, ["new-mem.md"]);
});

Deno.test("contextRefreshMiddleware ignores dry_run writes", async () => {
  let reloaded = false;
  const skills = { reload: () => { reloaded = true; return Promise.resolve(); } };
  const refreshFiles = () => Promise.resolve([]);
  const mw = contextRefreshMiddleware({ skills, refreshMemoryFiles: refreshFiles });
  const session = makeSession();

  const toolResult: ToolResultEvent = {
    eventId: 3, timestamp: Date.now(), iterationId: 1,
    type: "tool_result", callId: "tc1", name: "write_file",
    arguments: { path: "skills/new.md", content: "# Skill", dry_run: true },
    result: { success: true, output: "preview" },
  };
  await mw({ event: toolResult, session }, () => Promise.resolve(undefined));

  const llmReq: LlmRequestEvent = {
    eventId: 4, timestamp: Date.now(), iterationId: 2,
    type: "llm_request",  tools: [], config: { model: "m" },
  };
  await mw({ event: llmReq, session }, () => Promise.resolve({ type: "llm" as const, content: "ok" }));
  assertEquals(reloaded, false);
});
