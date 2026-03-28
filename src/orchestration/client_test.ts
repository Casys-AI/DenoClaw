import { assertEquals, assertExists } from "@std/assert";
import { BrokerClient } from "./client.ts";
import type { BrokerMessage } from "./types.ts";
import type { Task } from "../messaging/a2a/types.ts";

function createTask(taskId: string): Task {
  return {
    id: taskId,
    contextId: `${taskId}-ctx`,
    status: {
      state: "SUBMITTED",
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [
      {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
      },
    ],
  };
}

function startBrokerResponder(kv: Deno.Kv): void {
  kv.listenQueue(async (raw: unknown) => {
    const message = raw as BrokerMessage;
    if (message.to !== "broker") return;

    let response: BrokerMessage | null = null;

    switch (message.type) {
      case "task_submit":
        response = {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: { task: createTask(message.payload.taskId) },
          timestamp: new Date().toISOString(),
        };
        break;
      case "task_get":
        response = {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: { task: createTask(message.payload.taskId) },
          timestamp: new Date().toISOString(),
        };
        break;
      case "task_continue":
        response = {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: {
            task: {
              ...createTask(message.payload.taskId),
              status: {
                state: "WORKING",
                timestamp: new Date().toISOString(),
                metadata: message.payload.metadata,
              },
            },
          },
          timestamp: new Date().toISOString(),
        };
        break;
      case "task_cancel":
        response = {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: {
            task: {
              ...createTask(message.payload.taskId),
              status: {
                state: "CANCELED",
                timestamp: new Date().toISOString(),
              },
            },
          },
          timestamp: new Date().toISOString(),
        };
        break;
      case "agent_message":
        response = {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "agent_response",
          payload: {
            accepted: true,
            targetAgent: message.payload.targetAgent ?? "unknown-target",
          },
          timestamp: new Date().toISOString(),
        };
        break;
      default:
        response = {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "error",
          payload: {
            code: "UNEXPECTED_TEST_MESSAGE",
            context: { type: message.type },
            recovery: "Update test responder",
          },
          timestamp: new Date().toISOString(),
        };
    }

    await kv.enqueue(response);
  });
}

Deno.test("BrokerClient submit/get/continue/cancel use canonical task operations", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    startBrokerResponder(kv);
    const client = new BrokerClient("agent-alpha", { kv });
    await client.startListening();

    const submitted = await client.submitTask({
      targetAgent: "agent-beta",
      taskId: "task-1",
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
      },
    });
    assertEquals(submitted.id, "task-1");
    assertEquals(submitted.status.state, "SUBMITTED");

    const fetched = await client.getTask("task-1");
    assertExists(fetched);
    assertEquals(fetched?.id, "task-1");

    const resumed = await client.continueTask({
      taskId: "task-1",
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "continue" }],
      },
      metadata: { resume: { kind: "approval", approved: true } },
    });
    assertExists(resumed);
    assertEquals(resumed?.status.state, "WORKING");

    const canceled = await client.cancelTask("task-1");
    assertExists(canceled);
    assertEquals(canceled?.status.state, "CANCELED");

    client.close();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerClient.sendToAgent resolves broker acknowledgement instead of hanging", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    startBrokerResponder(kv);
    const client = new BrokerClient("agent-alpha", { kv });
    await client.startListening();

    const response = await client.sendToAgent("agent-beta", "ping", {
      correlation: "demo",
    }) as Extract<BrokerMessage, { type: "agent_response" }>;

    assertEquals(response.type, "agent_response");
    assertEquals(response.payload.accepted, true);
    assertEquals(response.payload.targetAgent, "agent-beta");

    client.close();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
