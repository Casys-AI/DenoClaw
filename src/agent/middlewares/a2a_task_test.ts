import { assertEquals, assertRejects } from "@std/assert";
import { a2aTaskMiddleware, PrivilegeElevationPause } from "./a2a_task.ts";
import type { CompleteEvent, ErrorEvent, ToolCallEvent } from "../events.ts";
import type { SessionState } from "../middleware.ts";
import type { Task } from "../../messaging/a2a/types.ts";

function makeTask(): Task {
  return {
    id: "task-1", contextId: "ctx-1",
    status: { state: "WORKING", timestamp: new Date().toISOString() },
    history: [], artifacts: [],
  };
}

function makeSession(task?: Task): SessionState {
  return {
    agentId: "agent-1", sessionId: "s",
    memoryFiles: [],
    canonicalTask: task ?? makeTask(),
  };
}

Deno.test("a2aTaskMiddleware passes tool_call through to next and returns resolution", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => { reportedTasks.push(task); return Promise.resolve(); },
  });
  const event: ToolCallEvent = {
    eventId: 2, timestamp: Date.now(), iterationId: 1,
    type: "tool_call", callId: "tc1", name: "shell", arguments: { command: "ls" },
  };
  const toolResolution = { type: "tool" as const, result: { success: true, output: "file.txt" } };
  const result = await mw({ event, session: makeSession() }, () => Promise.resolve(toolResolution));
  assertEquals(result, toolResolution);
  assertEquals(reportedTasks.length, 0);
});

Deno.test("a2aTaskMiddleware throws PrivilegeElevationPause on privilege elevation", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => { reportedTasks.push(task); return Promise.resolve(); },
  });
  const event: ToolCallEvent = {
    eventId: 2, timestamp: Date.now(), iterationId: 1,
    type: "tool_call", callId: "tc1", name: "shell", arguments: { command: "rm -rf /" },
  };
  const toolResolution = {
    type: "tool" as const,
    result: {
      success: false, output: "",
      error: {
        code: "PRIVILEGE_ELEVATION_REQUIRED",
        context: {
          suggestedGrants: [{ permission: "run", resource: "rm" }],
          privilegeElevationScopes: ["once"],
          command: "rm -rf /", binary: "rm",
          elevationAvailable: true, privilegeElevationSupported: true,
        },
        recovery: "Approve to execute",
      },
    },
  };
  await assertRejects(
    () => mw({ event, session: makeSession() }, () => Promise.resolve(toolResolution)),
    PrivilegeElevationPause,
  );
  assertEquals(reportedTasks.length, 1);
  assertEquals(reportedTasks[0].status.state, "INPUT_REQUIRED");
});

Deno.test("a2aTaskMiddleware reports COMPLETED on complete event", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => { reportedTasks.push(task); return Promise.resolve(); },
  });
  const event: CompleteEvent = {
    eventId: 5, timestamp: Date.now(), iterationId: 2,
    type: "complete", content: "final answer",
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(reportedTasks.length, 1);
  assertEquals(reportedTasks[0].status.state, "COMPLETED");
});

Deno.test("a2aTaskMiddleware reports FAILED on error event", async () => {
  const reportedTasks: Task[] = [];
  const mw = a2aTaskMiddleware({
    reportTaskResult: (task) => { reportedTasks.push(task); return Promise.resolve(); },
  });
  const event: ErrorEvent = {
    eventId: 5, timestamp: Date.now(), iterationId: 3,
    type: "error", code: "max_iterations", recovery: "try again",
  };
  await mw({ event, session: makeSession() }, () => Promise.resolve(undefined));
  assertEquals(reportedTasks.length, 1);
  const state = reportedTasks[0].status.state;
  assertEquals(state === "FAILED" || state === "CANCELED", true);
});
