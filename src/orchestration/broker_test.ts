import {
  assertEquals,
  assertExists,
  assertRejects,
} from "@std/assert";
import { BrokerServer } from "./broker.ts";
import { createResumePayloadMetadata } from "../messaging/a2a/input_metadata.ts";
import type { BrokerMessage } from "./types.ts";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";

function createConfig() {
  return {
    providers: {},
    agents: {
      defaults: { model: "test/model", temperature: 0.2, maxTokens: 256 },
    },
    tools: {},
    channels: {},
  };
}

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

async function seedPeerPolicy(
  kv: Deno.Kv,
  fromAgentId: string,
  targetAgentId: string,
): Promise<void> {
  await kv.set(["agents", fromAgentId, "config"], {
    peers: [targetAgentId],
  });
  await kv.set(["agents", targetAgentId, "config"], {
    acceptFrom: [fromAgentId],
  });
}

function waitForQueuedMessage(
  kv: Deno.Kv,
  predicate: (message: BrokerMessage) => boolean,
): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for queued message"));
    }, 5_000);

    kv.listenQueue((raw: unknown) => {
      const message = raw as BrokerMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

Deno.test("BrokerServer.submitAgentTask persists canonical task and forwards legacy bridge message", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });
    const forwardedPromise = waitForQueuedMessage(
      kv,
      (message) => message.type === "agent_message" && message.to === "agent-beta",
    );

    const task = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-1",
      contextId: "ctx-1",
      message: createMessage("Summarise this"),
      metadata: { source: "test" },
    });

    assertEquals(task.id, "task-1");
    assertEquals(task.contextId, "ctx-1");
    assertEquals(task.status.state, "SUBMITTED");
    assertEquals(task.metadata?.broker, {
      submittedBy: "agent-alpha",
      targetAgent: "agent-beta",
      request: { source: "test" },
    });

    const persisted = await broker.getTask({ taskId: "task-1" });
    assertExists(persisted);
    assertEquals(persisted?.metadata?.broker, task.metadata?.broker);

    const forwarded = await forwardedPromise as Extract<
      BrokerMessage,
      { type: "agent_message" }
    >;
    assertEquals(forwarded.type, "agent_message");
    assertEquals(forwarded.payload.taskId, "task-1");
    assertEquals(forwarded.payload.contextId, "ctx-1");
    assertEquals(forwarded.payload.instruction, "Summarise this");
    assertEquals(forwarded.payload.metadata, { bridge: "legacy-agent_message" });

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.continueAgentTask resumes paused task and appends history", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-continue",
      contextId: "ctx-continue",
      message: createMessage("Need approval"),
    });

    const paused: Task = {
      ...submitted,
      status: {
        state: "INPUT_REQUIRED",
        timestamp: new Date().toISOString(),
        metadata: { awaitedInput: { kind: "approval", prompt: "approve?" } },
      },
    };
    await kv.set(["a2a_tasks", paused.id], paused);

    const resumed = await broker.continueAgentTask("agent-alpha", {
      taskId: paused.id,
      message: createMessage("Approved, continue"),
      metadata: createResumePayloadMetadata({ kind: "approval", approved: true }),
    });

    assertExists(resumed);
    assertEquals(resumed?.status.state, "WORKING");
    assertEquals(resumed?.history.at(-1)?.parts[0], {
      kind: "text",
      text: "Approved, continue",
    });

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.continueAgentTask classifies explicit refusal as REJECTED", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await seedPeerPolicy(kv, "agent-alpha", "agent-beta");
    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    const submitted = await broker.submitAgentTask("agent-alpha", {
      targetAgent: "agent-beta",
      taskId: "task-reject",
      message: createMessage("Dangerous action"),
    });

    await kv.set(["a2a_tasks", submitted.id], {
      ...submitted,
      status: {
        state: "INPUT_REQUIRED",
        timestamp: new Date().toISOString(),
      },
    });

    const rejected = await broker.continueAgentTask("agent-alpha", {
      taskId: submitted.id,
      message: createMessage("No"),
      metadata: createResumePayloadMetadata({ kind: "approval", approved: false }),
    });

    assertExists(rejected);
    assertEquals(rejected?.status.state, "REJECTED");

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerServer.submitAgentTask enforces peer policy", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    await kv.set(["agents", "agent-alpha", "config"], { peers: [] });
    await kv.set(["agents", "agent-beta", "config"], { acceptFrom: ["agent-alpha"] });

    const broker = new BrokerServer(createConfig(), {
      kv,
      // deno-lint-ignore no-explicit-any
      metrics: { recordAgentMessage: async () => {} } as any,
    });

    await assertRejects(
      () =>
        broker.submitAgentTask("agent-alpha", {
          targetAgent: "agent-beta",
          taskId: "blocked-task",
          message: createMessage("Blocked"),
        }),
      Error,
      'Add "agent-beta" to agent-alpha.peers',
    );

    await broker.stop();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
