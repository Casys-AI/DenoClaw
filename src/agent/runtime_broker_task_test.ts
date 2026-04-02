import { assertEquals, assertRejects } from "@std/assert";
import { AgentRuntime } from "./runtime.ts";
import type { MemoryPort } from "./memory_port.ts";
import type {
  RuntimeTaskContinueMessage,
  RuntimeTaskSubmitMessage,
} from "./runtime_transport.ts";
import type {
  AgentCanonicalTaskPort,
  AgentLlmToolPort,
  LLMResponse,
  Message,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";
import type { Task } from "../messaging/a2a/types.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";

type BrokerTaskPortStub = AgentLlmToolPort & AgentCanonicalTaskPort<Task> & {
  reportedTasks: Task[];
  currentTask: Task | null;
  lastExecCorrelation?: { taskId?: string; contextId?: string };
  lastExecTool?: string;
  lastExecArgs?: Record<string, unknown>;
  lastTools?: ToolDefinition[];
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
  getMessages(): Promise<Message[]> {
    return Promise.resolve([...this.messages]);
  }
  getRecentMessages(count: number): Promise<Message[]> {
    return Promise.resolve(this.messages.slice(-count));
  }
  semanticRecall(_query: string, _topK?: number): Promise<Message[]> {
    return Promise.resolve([]);
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
  recallTopic(): Promise<[]> {
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
    complete(
      _messages: Message[],
      _model: string,
      _temperature?: number,
      _maxTokens?: number,
      tools?: ToolDefinition[],
    ): Promise<LLMResponse> {
      this.lastTools = tools;
      return Promise.resolve({ content: responseText });
    },
    execTool(
      tool: string,
      args: Record<string, unknown>,
      correlation?: { taskId?: string; contextId?: string },
    ): Promise<ToolResult> {
      this.lastExecTool = tool;
      this.lastExecArgs = args;
      this.lastExecCorrelation = correlation;
      return Promise.reject(
        new Error("execTool should not be called in this test"),
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
    broker,
  );

  const runtimeAny = runtime as unknown as {
    getMemory(sessionId: string): Promise<MemoryPort>;
    skills: { getSkills(): never[] };
    context: {
      buildContextMessages(
        messages: Message[],
        _skills: unknown[],
        _facts: unknown[],
        _memoryTopics?: string[],
        _memoryFiles?: string[],
        runtimeGrants?: AgentRuntimeGrant[],
      ): Message[];
    };
    lastRuntimeGrants?: AgentRuntimeGrant[];
    handleTaskSubmitMessage(msg: RuntimeTaskSubmitMessage): Promise<void>;
    handleTaskContinueMessage(msg: RuntimeTaskContinueMessage): Promise<void>;
  };

  runtimeAny.getMemory = (_sessionId: string) => Promise.resolve(memory);
  runtimeAny.skills = { getSkills: () => [] };
  runtimeAny.context = {
    buildContextMessages(
      messages: Message[],
      _skills?: unknown[],
      _facts?: unknown[],
      _memoryTopics?: string[],
      _memoryFiles?: string[],
      runtimeGrants?: AgentRuntimeGrant[],
    ) {
      runtimeAny.lastRuntimeGrants = runtimeGrants;
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
    handleTaskSubmitMessage(msg: RuntimeTaskSubmitMessage): Promise<void>;
  };

  await runtimeAny.handleTaskSubmitMessage({
    id: "msg-1",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_submit",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: "task-1",
      contextId: "ctx-1",
      taskMessage: {
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
  assertEquals((await memory.getMessages()).map((message) => message.role), [
    "user",
    "assistant",
  ]);
  assertEquals(
    broker.lastTools?.map((tool) => tool.function.name).sort(),
    [
      "create_cron",
      "delete_cron",
      "disable_cron",
      "enable_cron",
      "list_crons",
      "read_file",
      "shell",
      "web_fetch",
      "write_file",
    ],
  );
});

Deno.test("AgentRuntime handles broker task_continue by resuming existing canonical task", async () => {
  const broker = createBrokerStub("resumed");
  broker.currentTask = {
    id: "task-continue",
    contextId: "ctx-continue",
    status: {
      state: "INPUT_REQUIRED",
      timestamp: new Date().toISOString(),
      metadata: {
        awaitedInput: {
          kind: "clarification",
          question: "Need more detail",
        },
      },
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
    handleTaskContinueMessage(msg: RuntimeTaskContinueMessage): Promise<void>;
    lastRuntimeGrants?: AgentRuntimeGrant[];
  };

  await runtimeAny.handleTaskContinueMessage({
    id: "msg-2",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_continue",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: "task-continue",
      continuationMessage: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "More detail, continue" }],
      },
    },
  });

  assertEquals(broker.reportedTasks.map((task) => task.status.state), [
    "WORKING",
    "COMPLETED",
  ]);
  assertEquals(broker.reportedTasks[0]?.history.length, 2);
  assertEquals(broker.reportedTasks[0]?.history[1]?.parts[0], {
    kind: "text",
    text: "More detail, continue",
  });
  assertEquals(broker.reportedTasks[1]?.artifacts[0]?.parts[0], {
    kind: "text",
    text: "resumed",
  });
  assertEquals(runtimeAny.lastRuntimeGrants, []);
});

Deno.test("AgentRuntime handles broker privilege-elevation resumes by rebuilding runtime grants", async () => {
  const broker = createBrokerStub("resumed with privilege grant");
  broker.currentTask = {
    id: "task-continue-privilege",
    contextId: "ctx-continue-privilege",
    status: {
      state: "INPUT_REQUIRED",
      timestamp: new Date().toISOString(),
      metadata: {
        awaitedInput: {
          kind: "privilege-elevation",
          grants: [{ permission: "write", paths: ["note.txt"] }],
          scope: "task",
          prompt: "Need temporary write access",
        },
      },
    },
    artifacts: [],
    history: [
      {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Write the file" }],
      },
    ],
  };
  const memory = new MemoryStub();
  const runtime = createRuntime(broker, memory);
  const runtimeAny = runtime as unknown as {
    handleTaskContinueMessage(msg: RuntimeTaskContinueMessage): Promise<void>;
    lastRuntimeGrants?: AgentRuntimeGrant[];
  };

  await runtimeAny.handleTaskContinueMessage({
    id: "msg-privilege-continue",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_continue",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: "task-continue-privilege",
      continuationMessage: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Grant write and continue" }],
      },
      metadata: {
        resume: {
          kind: "privilege-elevation",
          approved: true,
          scope: "task",
        },
      },
    },
  });

  assertEquals(runtimeAny.lastRuntimeGrants?.length, 1);
  const grant = runtimeAny.lastRuntimeGrants?.[0];
  assertEquals(grant?.kind, "privilege-elevation");
  if (!grant || grant.kind !== "privilege-elevation") {
    throw new Error("expected privilege-elevation grant");
  }
  assertEquals(grant.scope, "task");
  assertEquals(grant.grants, [{ permission: "write", paths: ["note.txt"] }]);
  assertEquals(grant.source, "broker-resume");
});

Deno.test("AgentRuntime turns broker privilege elevation requirements into canonical INPUT_REQUIRED", async () => {
  const broker = createBrokerStub();
  broker.complete = () =>
    Promise.resolve({
      content: "",
      toolCalls: [
        {
          id: "tool-privilege",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "note.txt",
              content: "hello",
            }),
          },
        },
      ],
    });
  broker.execTool = (_tool, _args, correlation) => {
    broker.lastExecCorrelation = correlation;
    return Promise.resolve({
      success: false,
      output: "",
      error: {
        code: "PRIVILEGE_ELEVATION_REQUIRED",
        context: {
          suggestedGrants: [{ permission: "write", paths: ["note.txt"] }],
          command: "write_file",
          binary: "write_file",
          elevationAvailable: true,
          privilegeElevationScopes: ["once", "task", "session"],
        },
        recovery: "Temporarily grant write access to continue",
      },
    });
  };

  const memory = new MemoryStub();
  const runtime = createRuntime(broker, memory);
  const runtimeAny = runtime as unknown as {
    handleTaskSubmitMessage(msg: RuntimeTaskSubmitMessage): Promise<void>;
  };

  await runtimeAny.handleTaskSubmitMessage({
    id: "msg-privilege-pause",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_submit",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: "task-privilege-pause",
      contextId: "ctx-privilege-pause",
      taskMessage: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Write note.txt" }],
      },
    },
  });

  assertEquals(broker.reportedTasks.map((task) => task.status.state), [
    "WORKING",
    "INPUT_REQUIRED",
  ]);
  const awaitedInput = broker.reportedTasks[1]?.status.metadata?.awaitedInput as
    | {
      kind?: string;
      grants?: unknown[];
      scope?: string;
      prompt?: string;
      command?: string;
      binary?: string;
      pendingTool?: unknown;
    }
    | undefined;
  assertEquals(awaitedInput?.kind, "privilege-elevation");
  assertEquals(awaitedInput?.grants, [
    { permission: "write", paths: ["note.txt"] },
  ]);
  assertEquals(awaitedInput?.scope, "session");
  assertEquals(
    awaitedInput?.prompt,
    "Temporarily grant write access to continue",
  );
  assertEquals(awaitedInput?.command, "write_file");
  assertEquals(awaitedInput?.binary, "write_file");
  assertEquals(awaitedInput?.pendingTool, {
    tool: "write_file",
    args: {
      path: "note.txt",
      content: "hello",
    },
    toolCallId: "tool-privilege",
  });
  assertEquals(broker.lastExecCorrelation, {
    taskId: "task-privilege-pause",
    contextId: "ctx-privilege-pause",
  });
  const msgs449 = await memory.getMessages();
  assertEquals(msgs449.length, 2);
  assertEquals(msgs449[0]?.role, "user");
  assertEquals(msgs449[1]?.role, "assistant");
});

Deno.test("AgentRuntime auto-retries a pending privileged tool after grant approval", async () => {
  const broker = createBrokerStub("write completed");
  broker.currentTask = {
    id: "task-continue-pending-tool",
    contextId: "ctx-continue-pending-tool",
    status: {
      state: "INPUT_REQUIRED",
      timestamp: new Date().toISOString(),
      metadata: {
        awaitedInput: {
          kind: "privilege-elevation",
          grants: [{ permission: "write", paths: ["note.txt"] }],
          scope: "task",
          prompt: "Need temporary write access",
          pendingTool: {
            tool: "write_file",
            args: {
              path: "note.txt",
              content: "hello",
            },
            toolCallId: "tool-retry-1",
          },
        },
      },
    },
    artifacts: [],
    history: [
      {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Write note.txt" }],
      },
    ],
  };
  broker.execTool = (tool, args, correlation) => {
    broker.lastExecTool = tool;
    broker.lastExecArgs = args;
    broker.lastExecCorrelation = correlation;
    return Promise.resolve({
      success: true,
      output: "Written 5 chars to note.txt",
    });
  };

  const memory = new MemoryStub();
  memory.messages = [
    { role: "user", content: "Write note.txt" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "tool-retry-1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "note.txt",
              content: "hello",
            }),
          },
        },
      ],
    },
  ];
  const runtime = createRuntime(broker, memory);
  const runtimeAny = runtime as unknown as {
    handleTaskContinueMessage(msg: RuntimeTaskContinueMessage): Promise<void>;
  };

  await runtimeAny.handleTaskContinueMessage({
    id: "msg-privilege-auto-retry",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_continue",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: "task-continue-pending-tool",
      continuationMessage: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Grant write and continue" }],
      },
      metadata: {
        resume: {
          kind: "privilege-elevation",
          approved: true,
          grants: [{ permission: "write", paths: ["note.txt"] }],
          scope: "task",
        },
      },
    },
  });

  assertEquals(broker.lastExecTool, "write_file");
  assertEquals(broker.lastExecArgs, {
    path: "note.txt",
    content: "hello",
  });
  assertEquals(broker.lastExecCorrelation, {
    taskId: "task-continue-pending-tool",
    contextId: "ctx-continue-pending-tool",
  });
  assertEquals(broker.reportedTasks.map((task) => task.status.state), [
    "WORKING",
    "COMPLETED",
  ]);
  const msgs562 = await memory.getMessages();
  assertEquals(msgs562.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "user",
    "assistant",
  ]);
  assertEquals(msgs562[2], {
    role: "tool",
    content: "Written 5 chars to note.txt",
    name: "write_file",
    tool_call_id: "tool-retry-1",
  });
  assertEquals(msgs562[3], {
    role: "user",
    content: "Grant write and continue",
  });
  assertEquals(broker.reportedTasks[1]?.artifacts[0]?.parts[0], {
    kind: "text",
    text: "write completed",
  });
});

Deno.test("AgentRuntime rejects non-canonical broker envelopes fail-fast", async () => {
  const broker = createBrokerStub();
  const memory = new MemoryStub();
  const runtime = createRuntime(broker, memory);

  await assertRejects(
    async () => {
      await runtime.handleIncomingMessage({
        id: "msg-noop",
        from: "broker",
        to: "agent-beta",
        type: "tool_response",
        timestamp: new Date().toISOString(),
        payload: {
          success: true,
          output: "noop",
        },
      } as never);
    },
    Error,
    "INVALID_BROKER_MESSAGE",
  );

  assertEquals(broker.reportedTasks.length, 0);
  assertEquals((await memory.getMessages()).length, 0);
});
