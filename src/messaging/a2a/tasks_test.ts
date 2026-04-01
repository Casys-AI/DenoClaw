import { assertEquals } from "@std/assert";
import { TaskStore } from "./tasks.ts";
import type { A2AMessage } from "./types.ts";

function makeMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

Deno.test("TaskStore.updateStatus does not duplicate status message in history", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const store = new TaskStore(kv);

  try {
    await store.create("task-1", makeMessage("hello"));

    const completed = await store.completeTask("task-1", makeMessage("done"));

    assertEquals(completed?.history.length, 1);
    assertEquals(completed?.status.message?.parts[0]?.kind, "text");
  } finally {
    store.close();
    kv.close();
    await Deno.remove(kvPath);
  }
});
