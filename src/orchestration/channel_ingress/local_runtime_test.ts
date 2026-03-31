import { assertEquals, assertRejects } from "@std/assert";
import { AgentError } from "../../shared/errors.ts";
import { createAwaitedInputMetadata } from "../../messaging/a2a/input_metadata.ts";
import { TaskStore } from "../../messaging/a2a/tasks.ts";
import { transitionTask } from "../../messaging/a2a/internal_contract.ts";
import { createChannelTaskMessage } from "./task_message.ts";
import { LocalChannelIngressRuntime } from "./local_runtime.ts";

function createMessage(overrides: Partial<{
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  channelType: string;
}> = {}) {
  return {
    id: overrides.id ?? "msg-1",
    sessionId: overrides.sessionId ?? "session-1",
    userId: overrides.userId ?? "user-1",
    content: overrides.content ?? "hello",
    channelType: overrides.channelType ?? "telegram",
    timestamp: new Date().toISOString(),
    address: {
      channelType: overrides.channelType ?? "telegram",
      userId: overrides.userId ?? "user-1",
      roomId: overrides.userId ?? "user-1",
    },
  };
}

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name:
    "LocalChannelIngressRuntime submits and persists completed channel tasks",
  async fn() {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const taskStore = new TaskStore(kv);
    const observed: {
      agentId?: string;
      sessionId?: string;
      message?: string;
      model?: string;
      taskId?: string;
      contextId?: string;
    } = {};
    const runtime = new LocalChannelIngressRuntime({
      taskStore,
      workerPool: {
        send: (agentId, sessionId, message, options) => {
          observed.agentId = agentId;
          observed.sessionId = sessionId;
          observed.message = message;
          observed.model = options?.model;
          observed.taskId = options?.taskId;
          observed.contextId = options?.contextId;
          return Promise.resolve({ content: "PONG" });
        },
      },
    });

    try {
      const submission = await runtime.submit(createMessage(), {
        agentId: "agent-alpha",
        metadata: { model: "openai/gpt-5.4", source: "http" },
      });

      assertEquals(submission.task.status.state, "COMPLETED");
      assertEquals(submission.task.artifacts[0]?.parts[0], {
        kind: "text",
        text: "PONG",
      });
      assertEquals(
        submission.task.metadata?.channelIngress,
        {
          targetAgent: "agent-alpha",
          channelType: "telegram",
          sessionId: "session-1",
          userId: "user-1",
          address: {
            channelType: "telegram",
            userId: "user-1",
            roomId: "user-1",
          },
        },
      );
      assertEquals(submission.task.metadata?.request, {
        ingress: { model: "openai/gpt-5.4", source: "http" },
      });
      assertEquals(observed.agentId, "agent-alpha");
      assertEquals(observed.sessionId, "session-1");
      assertEquals(observed.message, "hello");
      assertEquals(observed.model, "openai/gpt-5.4");
      assertEquals(observed.taskId, submission.taskId);
      assertEquals(observed.contextId, "session-1");

      const stored = await runtime.getTask(submission.taskId);
      assertEquals(stored?.status.state, "COMPLETED");
    } finally {
      runtime.close();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
  ...testOpts,
});

Deno.test({
  name:
    "LocalChannelIngressRuntime maps runtime failures to terminal task state",
  async fn() {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const taskStore = new TaskStore(kv);
    const runtime = new LocalChannelIngressRuntime({
      taskStore,
      workerPool: {
        send: () =>
          Promise.reject(
            new AgentError("USER_DENIED", { command: "git push" }, "denied"),
          ),
      },
    });

    try {
      const submission = await runtime.submit(createMessage(), {
        agentId: "agent-alpha",
      });
      assertEquals(submission.task.status.state, "REJECTED");
    } finally {
      runtime.close();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
  ...testOpts,
});

Deno.test({
  name:
    "LocalChannelIngressRuntime resumes INPUT_REQUIRED tasks through continueTask",
  async fn() {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const taskStore = new TaskStore(kv);
    const runtime = new LocalChannelIngressRuntime({
      taskStore,
      workerPool: {
        send: () => Promise.resolve({ content: "continued" }),
      },
    });

    try {
      const message = createMessage({
        id: "msg-init",
        content: "Need temporary write access",
      });
      const task = await taskStore.create(
        "task-1",
        createChannelTaskMessage(message),
        message.sessionId,
      );
      const paused = transitionTask(task, "INPUT_REQUIRED", {
        metadata: createAwaitedInputMetadata({
          kind: "privilege-elevation",
          grants: [{ permission: "write", paths: ["note.txt"] }],
          scope: "task",
        }),
      });
      paused.metadata = {
        ...(paused.metadata ?? {}),
        channelIngress: {
          targetAgent: "agent-alpha",
          channelType: message.channelType,
          sessionId: message.sessionId,
          userId: message.userId,
          address: message.address,
        },
      };
      await taskStore.put(paused);

      const resumed = await runtime.continueTask(
        "task-1",
        createMessage({
          id: "msg-next",
          content: "Grant write on note.txt and continue",
        }),
      );

      assertEquals(resumed?.status.state, "COMPLETED");
      assertEquals(resumed?.artifacts[0]?.parts[0], {
        kind: "text",
        text: "continued",
      });
    } finally {
      runtime.close();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
  ...testOpts,
});

Deno.test({
  name: "LocalChannelIngressRuntime rejects continueTask for non-paused tasks",
  async fn() {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const taskStore = new TaskStore(kv);
    const runtime = new LocalChannelIngressRuntime({
      taskStore,
      workerPool: {
        send: () => Promise.resolve({ content: "ignored" }),
      },
    });

    try {
      const message = createMessage();
      const task = await taskStore.create(
        "task-2",
        createChannelTaskMessage(message),
        message.sessionId,
      );
      await taskStore.put(task);

      await assertRejects(
        () => runtime.continueTask("task-2", createMessage({ id: "msg-2" })),
        Error,
        "Only INPUT_REQUIRED tasks can be resumed through channel ingress",
      );
    } finally {
      runtime.close();
      kv.close();
      await Deno.remove(kvPath);
    }
  },
  ...testOpts,
});
