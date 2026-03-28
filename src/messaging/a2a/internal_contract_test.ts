import {
  appendArtifactToTask,
  assertValidTaskTransition,
  canTransitionTaskState,
  classifyRefusalTerminalState,
  createCanonicalTask,
  createInputRequiredTaskMetadata,
  isTerminalTaskState,
  resolveTaskContextId,
} from "./internal_contract.ts";
import { assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { A2AMessage, Artifact, Task } from "./types.ts";

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

function createTask(state: Task["status"]["state"]): Task {
  return {
    id: "task-123",
    contextId: "ctx-123",
    status: {
      state,
      timestamp: "2026-03-28T00:00:00.000Z",
    },
    artifacts: [],
    history: [createMessage("hello")],
  };
}

Deno.test("createCanonicalTask keeps a stable id and explicit context policy", () => {
  const task = createCanonicalTask({
    id: "task-1",
    message: createMessage("hello"),
  });

  assertEquals(task.id, "task-1");
  assertEquals(task.contextId, "task-1");
  assertEquals(resolveTaskContextId("task-1"), "task-1");
  assertEquals(resolveTaskContextId("task-1", "ctx-9"), "ctx-9");
});

Deno.test("canTransitionTaskState allows only canonical transitions", () => {
  assertEquals(canTransitionTaskState("SUBMITTED", "WORKING"), true);
  assertEquals(canTransitionTaskState("WORKING", "INPUT_REQUIRED"), true);
  assertEquals(canTransitionTaskState("INPUT_REQUIRED", "WORKING"), true);
  assertEquals(canTransitionTaskState("WORKING", "COMPLETED"), true);
  assertEquals(canTransitionTaskState("WORKING", "REJECTED"), true);
  assertFalse(canTransitionTaskState("COMPLETED", "WORKING"));
  assertFalse(canTransitionTaskState("FAILED", "COMPLETED"));
});

Deno.test("assertValidTaskTransition protects terminal states", () => {
  assertValidTaskTransition("INPUT_REQUIRED", "WORKING");
  assertThrows(() => assertValidTaskTransition("COMPLETED", "WORKING"));
});

Deno.test("isTerminalTaskState marks only terminal states", () => {
  assertEquals(isTerminalTaskState("COMPLETED"), true);
  assertEquals(isTerminalTaskState("REJECTED"), true);
  assertFalse(isTerminalTaskState("WORKING"));
});

Deno.test("createInputRequiredTaskMetadata keeps awaited-input details structured", () => {
  assertEquals(
    createInputRequiredTaskMetadata("approval", {
      command: "git status",
      binary: "git",
    }),
    {
      awaitingInput: true,
      kind: "approval",
      command: "git status",
      binary: "git",
    },
  );
});

Deno.test("classifyRefusalTerminalState maps refusal to REJECTED when applicable", () => {
  assertEquals(classifyRefusalTerminalState("user"), "REJECTED");
  assertEquals(classifyRefusalTerminalState("policy"), "REJECTED");
  assertEquals(classifyRefusalTerminalState("runtime"), "FAILED");
});

Deno.test("appendArtifactToTask does not mutate terminal tasks", () => {
  const terminalTask = createTask("COMPLETED");
  const artifact: Artifact = {
    artifactId: "artifact-1",
    parts: [{ kind: "text", text: "done" }],
  };

  const nextTerminalTask = appendArtifactToTask(terminalTask, artifact);
  assertEquals(nextTerminalTask.artifacts.length, 0);
  assertEquals(terminalTask.artifacts.length, 0);

  const workingTask = createTask("WORKING");
  const nextWorkingTask = appendArtifactToTask(workingTask, artifact);
  assertEquals(nextWorkingTask.artifacts.length, 1);
  assertEquals(workingTask.artifacts.length, 0);
});
