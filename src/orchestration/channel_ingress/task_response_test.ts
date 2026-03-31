import { assertEquals } from "@std/assert";
import { createCanonicalTask } from "../../messaging/a2a/internal_contract.ts";
import { createAwaitedInputMetadata } from "../../messaging/a2a/input_metadata.ts";
import { getChannelTaskResponseText } from "./task_response.ts";

Deno.test("getChannelTaskResponseText formats privilege elevation prompts from awaited input", () => {
  const task = createCanonicalTask({
    id: "task-1",
    contextId: "ctx-1",
    initialMessage: {
      messageId: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: "write note.txt" }],
    },
    metadata: {},
  });

  task.status = {
    state: "INPUT_REQUIRED",
    timestamp: new Date().toISOString(),
    metadata: createAwaitedInputMetadata({
      kind: "privilege-elevation",
      grants: [{ permission: "write", paths: ["note.txt"] }],
      scope: "task",
      command: "write_file",
      binary: "write_file",
    }),
  };

  assertEquals(
    getChannelTaskResponseText(task),
    "Temporary privilege elevation required for write_file (this task): write paths=[note.txt]",
  );
});
