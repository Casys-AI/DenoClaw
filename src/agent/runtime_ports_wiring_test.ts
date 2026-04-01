import { assertEquals, assertRejects } from "@std/assert";
import { AgentRuntime } from "./runtime.ts";
import type { MemoryPort } from "./memory_port.ts";
import type {
  AgentCanonicalTaskPort,
  AgentLlmToolPort,
  LLMResponse,
  Message,
  ToolResult,
} from "../shared/types.ts";
import type {
  RuntimeTaskContinueMessage,
  RuntimeTaskSubmitMessage,
} from "./runtime_transport.ts";
import type { Task } from "../messaging/a2a/types.ts";

class MemoryStub implements MemoryPort {
  private messages: Message[] = [];
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

function createRuntime(
  llmToolPort: AgentLlmToolPort,
  canonicalTaskPort: AgentCanonicalTaskPort<Task>,
): AgentRuntime {
  const runtime = new AgentRuntime(
    "agent-beta",
    { model: "test/model", systemPrompt: "test" },
    llmToolPort,
    canonicalTaskPort,
  );
  const runtimeAny = runtime as unknown as {
    getMemory(sessionId: string): Promise<MemoryPort>;
    skills: { getSkills(): never[] };
    context: {
      buildContextMessages(
        messages: Message[],
        _skills: unknown[],
        _facts: unknown[],
      ): Message[];
    };
  };

  runtimeAny.getMemory = () => Promise.resolve(new MemoryStub());
  runtimeAny.skills = { getSkills: () => [] };
  runtimeAny.context = {
    buildContextMessages: (messages: Message[]) => messages,
  };

  return runtime;
}

Deno.test(
  "AgentRuntime wires llm/tool and canonical task ports independently (nominal)",
  async () => {
    const calls = { complete: 0, getTask: 0, report: 0 };
    const seedTask: Task = {
      id: "task-wire",
      contextId: "ctx-wire",
      status: { state: "INPUT_REQUIRED", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [
        {
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: "start" }],
        },
      ],
    };

    const llmPort: AgentLlmToolPort = {
      startListening: () => Promise.resolve(),
      complete: (): Promise<LLMResponse> => {
        calls.complete += 1;
        return Promise.resolve({ content: "ok" });
      },
      execTool: (): Promise<ToolResult> =>
        Promise.reject(new Error("not used")),
      close: () => {},
    };

    let currentTask = seedTask;
    const taskPort: AgentCanonicalTaskPort<Task> = {
      getTask: () => {
        calls.getTask += 1;
        return Promise.resolve(currentTask);
      },
      reportTaskResult: (task) => {
        calls.report += 1;
        currentTask = task;
        return Promise.resolve(task);
      },
    };

    const runtime = createRuntime(llmPort, taskPort);
    const runtimeAny = runtime as unknown as {
      handleTaskContinueMessage(msg: RuntimeTaskContinueMessage): Promise<void>;
    };

    await runtimeAny.handleTaskContinueMessage({
      id: "msg-wire",
      from: "agent-alpha",
      to: "agent-beta",
      type: "task_continue",
      timestamp: new Date().toISOString(),
      payload: {
        taskId: "task-wire",
        continuationMessage: {
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: "continue" }],
        },
      },
    });

    assertEquals(calls.getTask, 1);
    assertEquals(calls.complete, 1);
    assertEquals(calls.report, 2);
  },
);

Deno.test(
  "AgentRuntime fails fast when canonical task port implementation is missing",
  async () => {
    const llmPort: AgentLlmToolPort = {
      startListening: () => Promise.resolve(),
      complete: () => Promise.resolve({ content: "ok" }),
      execTool: (): Promise<ToolResult> =>
        Promise.reject(new Error("not used")),
      close: () => {},
    };

    const brokenTaskPort = {
      getTask: (_taskId: string) => Promise.resolve(null as Task | null),
    } as unknown as AgentCanonicalTaskPort<Task>;

    const runtime = createRuntime(llmPort, brokenTaskPort);
    const runtimeAny = runtime as unknown as {
      handleTaskSubmitMessage(msg: RuntimeTaskSubmitMessage): Promise<void>;
    };

    await assertRejects(
      () =>
        runtimeAny.handleTaskSubmitMessage({
          id: "msg-missing-port",
          from: "agent-alpha",
          to: "agent-beta",
          type: "task_submit",
          timestamp: new Date().toISOString(),
          payload: {
            taskId: "task-missing",
            taskMessage: {
              messageId: crypto.randomUUID(),
              role: "user",
              parts: [{ kind: "text", text: "hello" }],
            },
          },
        }),
      TypeError,
    );
  },
);
