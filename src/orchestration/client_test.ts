import { assertEquals, assertExists } from "@std/assert";
import { BrokerClient } from "./client.ts";
import type { BrokerTransport } from "./transport.ts";
import { DenoClawError } from "../shared/errors.ts";
import { createBrokerRequestMessage } from "./transport_message_factory.ts";
import type { BrokerRequestMessage, BrokerResponseMessage } from "./types.ts";
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

class FakeBrokerTransport implements BrokerTransport {
  #started = false;

  constructor(
    private readonly agentId: string,
    private readonly responder: (
      request: BrokerRequestMessage,
    ) => Promise<BrokerResponseMessage> | BrokerResponseMessage,
  ) {}

  start(): Promise<void> {
    this.#started = true;
    return Promise.resolve();
  }

  async send(
    message: Omit<BrokerRequestMessage, "id" | "from" | "timestamp">,
  ): Promise<BrokerResponseMessage> {
    if (!this.#started) {
      throw new DenoClawError(
        "TRANSPORT_NOT_STARTED",
        { agentId: this.agentId },
        "Call start() before send()",
      );
    }

    return await this.responder(
      createBrokerRequestMessage(this.agentId, message),
    );
  }

  close(): void {
    this.#started = false;
  }
}

function createBrokerResponder(
  expectedAgentId: string,
): (request: BrokerRequestMessage) => BrokerResponseMessage {
  return (message: BrokerRequestMessage): BrokerResponseMessage => {
    assertEquals(message.from, expectedAgentId);

    switch (message.type) {
      case "task_submit":
        return {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: { task: createTask(message.payload.taskId) },
          timestamp: new Date().toISOString(),
        };
      case "task_get":
        return {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: { task: createTask(message.payload.taskId) },
          timestamp: new Date().toISOString(),
        };
      case "task_continue":
        return {
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
      case "task_cancel":
        return {
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
      case "task_result":
        return {
          id: message.id,
          from: "broker",
          to: message.from,
          type: "task_result",
          payload: { task: message.payload.task },
          timestamp: new Date().toISOString(),
        };
      default:
        return {
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
  };
}

Deno.test("BrokerClient submit/get/continue/cancel use canonical task operations", async () => {
  const client = new BrokerClient("agent-alpha", {
    transport: new FakeBrokerTransport(
      "agent-alpha",
      createBrokerResponder("agent-alpha"),
    ),
  });
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
    metadata: {
      resume: {
        kind: "privilege-elevation",
        approved: true,
        scope: "task",
        grants: [{ permission: "write", paths: ["docs"] }],
      },
    },
  });
  assertExists(resumed);
  assertEquals(resumed?.status.state, "WORKING");

  const canceled = await client.cancelTask("task-1");
  assertExists(canceled);
  assertEquals(canceled?.status.state, "CANCELED");

  client.close();
});

Deno.test("BrokerClient.reportTaskResult round-trips canonical task updates", async () => {
  const client = new BrokerClient("agent-beta", {
    transport: new FakeBrokerTransport(
      "agent-beta",
      createBrokerResponder("agent-beta"),
    ),
  });
  await client.startListening();

  const completed = await client.reportTaskResult({
    ...createTask("task-report"),
    status: {
      state: "COMPLETED",
      timestamp: new Date().toISOString(),
    },
    artifacts: [
      {
        artifactId: "task-report:result",
        name: "result",
        parts: [{ kind: "text", text: "done" }],
      },
    ],
  });

  assertEquals(completed.id, "task-report");
  assertEquals(completed.status.state, "COMPLETED");
  assertEquals(completed.artifacts[0]?.parts[0], {
    kind: "text",
    text: "done",
  });

  client.close();
});
