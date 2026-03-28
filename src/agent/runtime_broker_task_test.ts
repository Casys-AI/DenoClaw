import { assertEquals } from "@std/assert";
import { AgentRuntime } from "./runtime.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { AgentBrokerPort, BrokerEnvelope, LLMResponse, Message, ToolResult } from "../shared/types.ts";
import type { Task } from "../messaging/a2a/types.ts";

type BrokerTaskPortStub = AgentBrokerPort & {
  reportedTasks: Task[];
  currentTask: Task | null;
  getTask(taskId: string): Promise<Task | null>;
  reportTaskResult(task: Task): Promise<Task>;
};

class MemoryStub implements MemoryPort {
  messages: Message[] = [];

  load(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
  addMessage(message: Message): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
  getMessages(): Message[] {
    return [...this.messages];
  }
  getRecentMessages(count: number): Message[] {
    return this.messages.slice(-count);
  }
  clear(): Promise<void> {
    this.messages = [];
    return Promise.resolve();
  }
  get count(): number {
    return this.messages.length;
  }
  remember(): Promise<void> {
    return Promise.resolve();
  }
  recall(): Promise<[]> {
    return Promise.resolve([]);
  }
  listTopics(): Promise<string[]> {
    return Promise.resolve([]);
  }
  forgetTopic(): Promise<void> {
    return Promise.resolve();
  }
}

function createBrokerStub(responseText = "done"): BrokerTaskPortStub {
  return {
    reportedTasks: [],
    currentTask: null,
    startListening(): Promise<void> {
      return Promise.resolve();
    },
    complete(): Promise<LLMResponse> {
      return Promise.resolve({ content: responseText });
    },
    execTool(): Promise<ToolResult> {
      return Promise.reject(
        new Error("execTool should not be called in this test"),
      );
    },
    sendToAgent(): Promise<BrokerEnvelope> {
      return Promise.reject(
        new Error(
          "sendToAgent should not be called for canonical task flow",
        ),
      );
    },
    getTask(taskId: string): Promise<Task | null> {
      return Promise.resolve(
        this.currentTask?.id === taskId ? this.currentTask : null,
      );
    },
    reportTaskResult(task: Task): Promise<Task> {
      this.currentTask = task;
      this.reportedTasks.push(task);
      return Promise.resolve(task);
    },
    close(): void {},
  };
}

function createRuntime(
  broker: BrokerTaskPortStub,
  memory: MemoryStub,
): AgentRuntime {
  const runtime = new AgentRuntime(
    "agent-beta",
    {
      model: "test/model",
      systemPrompt: "test",
      temperature: 0.2,
      maxTokens: 256,
    },
    broker,
  );

  const runtimeAny = runtime as unknown as {
    getMemory(sessionId: string): Promise<MemoryPort>;
    skills: { getSkills(): never[] };
    context: { buildContextMessages(messages: Message[], _skills: unknown[], _facts: unknown[]): Message[] };
    handleTaskSubmitMessage(msg: BrokerEnvelope): Promise<void>;
    handleTaskContinueMessage(msg: BrokerEnvelope): Promise<void>;
  };

  runtimeAny.getMemory = (_sessionId: string) => Promise.resolve(memory);
  runtimeAny.skills = { getSkills: () => [] };
  runtimeAny.context = {
    buildContextMessages(messages: Message[]) {
      return messages;
    },
  };

  return runtime;
}

Deno.test("AgentRuntime handles broker task_submit through canonical task reporting", async () => {
  const broker = createBrokerStub("completed");
  const memory = new MemoryStub();
  const runtime = createRuntime(broker, memory);
  const runtimeAny = runtime as unknown as {
    handleTaskSubmitMessage(msg: BrokerEnvelope): Promise<void>;
  };

  await runtimeAny.handleTaskSubmitMessage({
    id: "msg-1",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_submit",
    timestamp: new Date().toISOString(),
    payload: {
      targetAgent: "agent-beta",
      taskId: "task-1",
      contextId: "ctx-1",
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Summarise this" }],
      },
    },
  });

  assertEquals(broker.reportedTasks.map((task) => task.status.state), [
    "WORKING",
    "COMPLETED",
  ]);
  assertEquals(broker.reportedTasks[1]?.artifacts[0]?.parts[0], {
    kind: "text",
    text: "completed",
  });
  assertEquals(memory.getMessages().map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

Deno.test("AgentRuntime handles broker task_continue by resuming existing canonical task", async () => {
  const broker = createBrokerStub("resumed");
  broker.currentTask = {
    id: "task-continue",
    contextId: "ctx-continue",
    status: {
      state: "INPUT_REQUIRED",
      timestamp: new Date().toISOString(),
      metadata: { awaitedInput: { kind: "approval", prompt: "approve?" } },
    },
    artifacts: [],
    history: [
      {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Initial request" }],
      },
    ],
  };
  const memory = new MemoryStub();
  const runtime = createRuntime(broker, memory);
  const runtimeAny = runtime as unknown as {
    handleTaskContinueMessage(msg: BrokerEnvelope): Promise<void>;
  };

  await runtimeAny.handleTaskContinueMessage({
    id: "msg-2",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_continue",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: "task-continue",
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Approved, continue" }],
      },
      metadata: { resume: { kind: "approval", approved: true } },
    },
  });

  assertEquals(broker.reportedTasks.map((task) => task.status.state), [
    "WORKING",
    "COMPLETED",
  ]);
  assertEquals(broker.reportedTasks[0]?.history.length, 2);
  assertEquals(broker.reportedTasks[0]?.history[1]?.parts[0], {
    kind: "text",
    text: "Approved, continue",
  });
  assertEquals(broker.reportedTasks[1]?.artifacts[0]?.parts[0], {
    kind: "text",
    text: "resumed",
  });
});
