import { assertEquals } from "@std/assert";
import { TaskStore } from "./tasks.ts";
import type { A2AMessage, Artifact } from "./types.ts";

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

Deno.test("TaskStore addMessage handles concurrent updates without losing events", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".sqlite3" });
  const kv = await Deno.openKv(kvPath);
  const store = new TaskStore(kv);

  try {
    const taskId = "task-concurrency-messages";
    await store.create(taskId, createMessage("initial"));

    const parallelUpdates = Array.from({ length: 20 }, (_, index) =>
      store.addMessage(taskId, createMessage(`message-${index}`))
    );
    await Promise.all(parallelUpdates);

    const task = await store.get(taskId);
    assertEquals(task?.history.length, 21);
    assertEquals(new Set(task?.history.map((entry) => entry.messageId)).size, 21);
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("TaskStore updateStatus and addArtifact remain consistent under concurrent writes", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".sqlite3" });
  const kv = await Deno.openKv(kvPath);
  const store = new TaskStore(kv);

  try {
    const taskId = "task-concurrency-events";
    await store.create(taskId, createMessage("initial"));

    const artifact: Artifact = {
      artifactId: "artifact-1",
      parts: [{ kind: "text", text: "event artifact" }],
    };

    const statusMessage = createMessage("now working");
    await Promise.all([
      store.updateStatus(taskId, "WORKING", statusMessage),
      store.addArtifact(taskId, artifact),
    ]);

    const task = await store.get(taskId);
    assertEquals(task?.status.state, "WORKING");
    assertEquals(task?.artifacts.length, 1);
    assertEquals(task?.history.length, 2);
    assertEquals(task?.history.at(-1)?.messageId, statusMessage.messageId);
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
