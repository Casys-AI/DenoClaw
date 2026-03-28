import { assertEquals } from "@std/assert";
import { AgentLoop } from "./loop.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type { MemoryPort } from "./memory_port.ts";
import type {
  LLMResponse,
  Message,
  SandboxPermission,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";
import type { AgentResponse } from "./types.ts";
import { BaseTool } from "./tools/registry.ts";
import { ProviderManager } from "../llm/manager.ts";
import { TraceWriter, type TraceCorrelationIds } from "../telemetry/traces.ts";

// Minimal AgentLoopConfig with no providers configured — enough to construct a loop
const minimalConfig = {
  agents: {
    defaults: {
      model: "test/model",
      temperature: 0.5,
      maxTokens: 512,
    },
  },
  providers: {},
  tools: {},
};

class StubTool extends BaseTool {
  name = "stub";
  description = "A stub tool for testing";
  permissions: SandboxPermission[] = [];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return Promise.resolve(this.ok("stub result"));
  }
}

class FakeMemory implements MemoryPort {
  #messages: Message[] = [];
  #facts = new Map<string, { content: string; timestamp: string }[]>();

  get count(): number {
    return this.#messages.length;
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    // no-op
  }

  addMessage(message: Message): Promise<void> {
    this.#messages.push(message);
    return Promise.resolve();
  }

  getMessages(): Message[] {
    return [...this.#messages];
  }

  getRecentMessages(count: number): Message[] {
    return this.#messages.slice(-count);
  }

  clear(): Promise<void> {
    this.#messages = [];
    return Promise.resolve();
  }

  remember(fact: { topic: string; content: string; source?: "user" | "agent" | "tool"; confidence?: number }): Promise<void> {
    const existing = this.#facts.get(fact.topic) ?? [];
    existing.push({ content: fact.content, timestamp: new Date().toISOString() });
    this.#facts.set(fact.topic, existing);
    return Promise.resolve();
  }

  recall(topic: string): Promise<{ topic: string; content: string; source?: "user" | "agent" | "tool"; confidence?: number; timestamp: string }[]> {
    return Promise.resolve(
      (this.#facts.get(topic) ?? []).map((fact) => ({
        topic,
        content: fact.content,
        timestamp: fact.timestamp,
      })),
    );
  }

  listTopics(): Promise<string[]> {
    return Promise.resolve([...this.#facts.keys()]);
  }

  forgetTopic(topic: string): Promise<void> {
    this.#facts.delete(topic);
    return Promise.resolve();
  }
}

class RecordingTraceWriter extends TraceWriter {
  startedWith: Array<{ agentId: string; sessionId: string; ids: TraceCorrelationIds }> = [];
  iterationIds: TraceCorrelationIds[] = [];

  constructor() {
    super({} as Deno.Kv);
  }

  override startTrace(
    agentId: string,
    sessionId: string,
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    this.startedWith.push({ agentId, sessionId, ids });
    return Promise.resolve("trace-test");
  }

  override writeIterationSpan(
    _traceId: string,
    _agentId: string,
    _iteration: number,
    _parentSpanId?: string,
    ids: TraceCorrelationIds = {},
  ): Promise<string> {
    this.iterationIds.push(ids);
    return Promise.resolve(`iter-${this.iterationIds.length}`);
  }

  override writeLLMSpan(): Promise<string> {
    return Promise.resolve("llm-span");
  }

  override endSpan(): Promise<void> {
    return Promise.resolve();
  }

  override endTrace(): Promise<void> {
    return Promise.resolve();
  }
}

function createProviderWithResponse(response: LLMResponse): ProviderManager {
  const provider = new ProviderManager({});
  provider.complete = () => Promise.resolve(response);
  return provider;
}

Deno.test({
  name:
    "AgentLoop accepts custom tools via AgentLoopDeps — auto-registration skipped",
  fn() {
    const registry = new ToolRegistry();
    registry.register(new StubTool());

    const loop = new AgentLoop("test-session", minimalConfig, {}, 10, {
      tools: registry,
    });

    const tools = loop.getTools();
    // Our injected stub + memory tool (always registered)
    assertEquals(tools.size, 2);
    const defs = tools.getDefinitions();
    assertEquals(defs.length, 2);
    const names = defs.map((d) => d.function.name).sort();
    assertEquals(names, ["memory", "stub"]);

    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentLoop registers built-in tools by default (no deps)",
  fn() {
    const loop = new AgentLoop("test-session-defaults", minimalConfig);

    const tools = loop.getTools();
    // 4 built-in tools + memory tool
    assertEquals(tools.size, 5);

    const names = tools.getDefinitions().map((d) => d.function.name).sort();
    assertEquals(names, [
      "memory",
      "read_file",
      "shell",
      "web_fetch",
      "write_file",
    ]);

    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentLoop close() does not throw",
  fn() {
    const loop = new AgentLoop("test-session-close", minimalConfig);
    // close() should not throw even if KV was never opened
    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentLoop propagates canonical task/context ids into traces",
  async fn() {
    const traceWriter = new RecordingTraceWriter();
    const memory = new FakeMemory();
    const providers = createProviderWithResponse({
      content: "done",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const loop = new AgentLoop("session-trace", minimalConfig, {}, 1, {
      providers,
      memory,
      traceWriter,
      taskId: "task-abc",
      contextId: "ctx-root",
      agentId: "agent-alpha",
    });

    const result = await loop.processMessage("hello");
    assertEquals(result.content, "done");
    assertEquals(traceWriter.startedWith, [{
      agentId: "agent-alpha",
      sessionId: "session-trace",
      ids: { taskId: "task-abc", contextId: "ctx-root" },
    }]);
    assertEquals(traceWriter.iterationIds, [{
      taskId: "task-abc",
      contextId: "ctx-root",
    }]);

    await loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "AgentLoop implements the canonical worker task interface shape",
  fn() {
    const loop = new AgentLoop("session-interface", minimalConfig);

    const processMessage: (message: string) => Promise<AgentResponse> = loop.processMessage.bind(loop);
    const maybeAskApproval = (loop as AgentLoop & {
      askApproval?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
    }).askApproval;

    assertEquals(typeof processMessage, "function");
    assertEquals(maybeAskApproval, undefined);

    loop.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
