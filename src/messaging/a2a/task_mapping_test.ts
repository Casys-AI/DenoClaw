import { assertEquals } from "@std/assert";
import { AgentError } from "../../shared/errors.ts";
import {
  mapLocalTextInputToTask,
  mapPrivilegeElevationPauseToInputRequiredTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
  resolveContextIdFromSessionId,
  resolveTaskIdFromRequestId,
} from "./task_mapping.ts";

Deno.test("task mapping keeps request/session ids aligned with canonical task/context ids", () => {
  assertEquals(resolveTaskIdFromRequestId("req-1"), "req-1");
  assertEquals(resolveContextIdFromSessionId("session-1"), "session-1");

  const task = mapLocalTextInputToTask({
    requestId: "req-1",
    sessionId: "session-1",
    message: "hello world",
  });

  assertEquals(task.id, "req-1");
  assertEquals(task.contextId, "session-1");
  assertEquals(task.history[0].role, "user");
  assertEquals(task.history[0].parts[0], { kind: "text", text: "hello world" });
  assertEquals(task.metadata, {
    localRuntime: {
      requestId: "req-1",
      sessionId: "session-1",
    },
  });
});

Deno.test("task mapping converts final textual output into artifact plus terminal status", () => {
  const task = mapLocalTextInputToTask({
    requestId: "req-2",
    sessionId: "session-2",
    message: "compute",
  });

  const completed = mapTaskResultToCompletion(task, "done");
  assertEquals(completed.status.state, "COMPLETED");
  assertEquals(completed.artifacts.length, 1);
  assertEquals(completed.artifacts[0].parts[0], { kind: "text", text: "done" });
});

Deno.test("task mapping classifies refusal errors as REJECTED and generic errors as FAILED", () => {
  const task = mapLocalTextInputToTask({
    requestId: "req-3",
    sessionId: "session-3",
    message: "run dangerous command",
  });

  const rejected = mapTaskErrorToTerminalStatus(
    task,
    new AgentError("USER_DENIED", { command: "rm -rf /" }, "denied by user"),
  );
  assertEquals(rejected.status.state, "REJECTED");
  assertEquals(rejected.status.metadata?.errorCode, "USER_DENIED");

  const failed = mapTaskErrorToTerminalStatus(task, new Error("boom"));
  assertEquals(failed.status.state, "FAILED");
  assertEquals(failed.status.metadata?.errorCode, "UNEXPECTED_ERROR");
});

Deno.test("task mapping turns privilege elevation pauses into INPUT_REQUIRED metadata", () => {
  const task = mapLocalTextInputToTask({
    requestId: "req-5",
    sessionId: "session-5",
    message: "write file",
  });

  const paused = mapPrivilegeElevationPauseToInputRequiredTask(task, {
    grants: [{ permission: "write", paths: ["note.txt"] }],
    scope: "task",
    prompt: "Need temporary write access",
    command: "write_file",
    binary: "write_file",
    pendingTool: {
      tool: "write_file",
      args: { path: "note.txt", content: "hello" },
      toolCallId: "tool-1",
    },
    continuationToken: "resume-456",
  });

  assertEquals(paused.status.state, "INPUT_REQUIRED");
  assertEquals(paused.status.metadata?.awaitedInput, {
    kind: "privilege-elevation",
    grants: [{ permission: "write", paths: ["note.txt"] }],
    scope: "task",
    prompt: "Need temporary write access",
    command: "write_file",
    binary: "write_file",
    pendingTool: {
      tool: "write_file",
      args: { path: "note.txt", content: "hello" },
      toolCallId: "tool-1",
    },
    continuationToken: "resume-456",
  });
});

Deno.test("task mapping formats privilege elevation pauses when no prompt is provided", () => {
  const task = mapLocalTextInputToTask({
    requestId: "req-6",
    sessionId: "session-6",
    message: "write file",
  });

  const paused = mapPrivilegeElevationPauseToInputRequiredTask(task, {
    grants: [{ permission: "write", paths: ["note.txt"] }],
    scope: "task",
    command: "write_file",
    binary: "write_file",
  });

  assertEquals(paused.status.message?.parts[0], {
    kind: "text",
    text:
      "Temporary privilege elevation required for write_file (this task): write paths=[note.txt]",
  });
});
