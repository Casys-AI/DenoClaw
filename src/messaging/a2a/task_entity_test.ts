import { assertEquals, assertThrows } from "@std/assert";
import { TaskEntity } from "./task_entity.ts";
import type { A2AMessage } from "./types.ts";

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

Deno.test("TaskEntity enforces transition invariants", () => {
  const task = TaskEntity.createCanonical({
    id: "task-1",
    message: createMessage("hello"),
  });

  const working = new TaskEntity(task).transitionTo("WORKING").task;
  assertEquals(working.status.state, "WORKING");

  assertThrows(() => new TaskEntity(working).transitionTo("SUBMITTED"));
});

Deno.test("TaskEntity keeps artifacts immutable when terminal", () => {
  const task = {
    ...TaskEntity.createCanonical({ id: "task-2", message: createMessage("hello") }),
    status: { state: "COMPLETED" as const, timestamp: new Date().toISOString() },
  };

  const next = new TaskEntity(task).appendArtifact({
    artifactId: "a1",
    parts: [{ kind: "text", text: "done" }],
  }).task;

  assertEquals(next.artifacts.length, 0);
});
