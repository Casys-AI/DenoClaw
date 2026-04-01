import { assertEquals, assertInstanceOf } from "@std/assert";
import type {
  A2ARuntimePort,
  CanonicalTaskLifecycleEvent,
  ContinueTaskRequest,
  SubmitTaskRequest,
} from "./runtime_port.ts";
import type {
  A2AMessage,
  Artifact,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "./types.ts";
import { createCanonicalTask, transitionTask } from "./internal_contract.ts";

class InMemoryRuntimePort implements A2ARuntimePort {
  #tasks = new Map<string, Task>();
  #events = new Map<string, CanonicalTaskLifecycleEvent[]>();

  #resolveCanonicalMessage(
    request: Pick<SubmitTaskRequest | ContinueTaskRequest, "canonicalMessage">,
  ): A2AMessage {
    if (!request.canonicalMessage) {
      throw new Error("Missing canonical message");
    }
    return request.canonicalMessage;
  }

  submitTask(request: SubmitTaskRequest): Promise<Task> {
    const task = createCanonicalTask({
      id: request.taskId,
      initialMessage: this.#resolveCanonicalMessage(request),
      contextId: request.contextId,
      metadata: request.metadata,
    });
    this.#tasks.set(task.id, task);
    this.#events.set(task.id, [
      {
        kind: "taskStatusUpdate",
        taskId: task.id,
        status: task.status,
        final: false,
      },
    ]);
    return Promise.resolve(task);
  }

  continueTask(request: ContinueTaskRequest): Promise<Task | null> {
    const task = this.#tasks.get(request.taskId);
    if (!task) return Promise.resolve(null);
    const continuationMessage = this.#resolveCanonicalMessage(request);

    const continued = transitionTask(
      { ...task, history: [...task.history, continuationMessage] },
      "WORKING",
      { metadata: request.metadata },
    );
    this.#tasks.set(request.taskId, continued);
    this.#events.get(request.taskId)?.push({
      kind: "taskStatusUpdate",
      taskId: request.taskId,
      status: continued.status,
      final: false,
    });
    return Promise.resolve(continued);
  }

  getTask(taskId: string): Promise<Task | null> {
    return Promise.resolve(this.#tasks.get(taskId) ?? null);
  }

  async *streamTaskEvents(
    taskId: string,
  ): AsyncIterable<CanonicalTaskLifecycleEvent> {
    for (const event of this.#events.get(taskId) ?? []) {
      yield event;
    }
  }

  cancelTask(taskId: string): Promise<Task | null> {
    const task = this.#tasks.get(taskId);
    if (!task) return Promise.resolve(null);

    const canceled: Task = {
      ...task,
      status: {
        state: "CANCELED",
        timestamp: new Date().toISOString(),
      },
    };
    this.#tasks.set(taskId, canceled);
    this.#events.get(taskId)?.push({
      kind: "taskStatusUpdate",
      taskId,
      status: canceled.status,
      final: true,
    });
    return Promise.resolve(canceled);
  }

  recordArtifact(taskId: string, artifact: Artifact): void {
    this.#events.get(taskId)?.push({
      kind: "artifactUpdate",
      taskId,
      artifact,
    });
  }
}

function createMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

Deno.test("A2A runtime port supports submit/get/continue/cancel flows", async () => {
  const port: A2ARuntimePort = new InMemoryRuntimePort();
  const taskId = "task-1";

  const created = await port.submitTask({
    taskId,
    canonicalMessage: createMessage("hello"),
  });
  assertEquals(created.id, taskId);
  assertEquals(created.contextId, taskId);
  assertEquals(created.status.state, "SUBMITTED");

  const loaded = await port.getTask(taskId);
  assertEquals(loaded?.id, taskId);

  const resumed = await port.continueTask({
    taskId,
    canonicalMessage: createMessage("continue"),
    metadata: { resumed: true },
  });
  assertEquals(resumed?.status.state, "WORKING");
  assertEquals(resumed?.history.length, 2);

  const canceled = await port.cancelTask(taskId);
  assertEquals(canceled?.status.state, "CANCELED");
});

Deno.test("A2A runtime port streams canonical status and artifact events", async () => {
  const port = new InMemoryRuntimePort();
  const taskId = "task-2";

  await port.submitTask({
    taskId,
    contextId: "ctx-2",
    canonicalMessage: createMessage("start"),
  });
  port.recordArtifact(taskId, {
    artifactId: "artifact-1",
    name: "answer",
    parts: [{ kind: "text", text: "done" }],
  });

  const events = [] as CanonicalTaskLifecycleEvent[];
  for await (const event of port.streamTaskEvents(taskId)) {
    events.push(event);
  }

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "taskStatusUpdate");
  assertEquals(events[1].kind, "artifactUpdate");

  const statusEvent = events[0] as TaskStatusUpdateEvent;
  const artifactEvent = events[1] as TaskArtifactUpdateEvent;
  assertEquals(statusEvent.taskId, taskId);
  assertEquals(statusEvent.status.state, "SUBMITTED");
  assertEquals(artifactEvent.artifact.name, "answer");
  assertInstanceOf(events[Symbol.iterator]().next().value, Object);
});
