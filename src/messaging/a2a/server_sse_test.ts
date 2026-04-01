import { assertEquals } from "@std/assert";
import { A2AServer } from "./server.ts";
import { TaskStore } from "./tasks.ts";
import type { AgentCard } from "./types.ts";

const testCard: AgentCard = {
  name: "test",
  description: "test agent",
  version: "1.0.0",
  protocolVersion: "1.0",
  url: "http://localhost:9999/a2a",
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};

Deno.test("message/stream first event is taskStatusUpdate SUBMITTED, not custom task frame", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const store = new TaskStore(kv);
  const server = new A2AServer(testCard, async (task, _msg) => {
    await server.completeTask(task.id, "done");
  }, { store });

  try {
    const req = new Request("http://localhost:9999/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/stream",
        params: {
          message: {
            messageId: "m1",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
      }),
    });

    const res = await server.handleRequest(req);
    const text = await res!.text();
    const frames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)));

    const firstResult = frames[0].result;
    assertEquals(firstResult.kind, "taskStatusUpdate");
    assertEquals(firstResult.status.state, "SUBMITTED");
  } finally {
    server.close();
    kv.close();
    await Deno.remove(kvPath);
  }
});
