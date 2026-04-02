import type { AgentResponse } from "./types.ts";
import type { AgentConfig } from "./types.ts";
import type { ErrorEvent, FinalEvent } from "./events.ts";
import { createEventFactory } from "./events.ts";
import { log } from "../shared/log.ts";
import { agentKernel } from "./kernel.ts";
import type { KernelInput } from "./kernel.ts";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import type { EventStore } from "./event_store.ts";
import { InMemoryEventStore } from "./event_store.ts";
import type { Message, ToolDefinition } from "../shared/types.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";
import type { Task } from "../messaging/a2a/types.ts";
import { llmMiddleware } from "./middlewares/llm.ts";
import type { CompleteFn } from "./middlewares/llm.ts";
import type { GetMessagesFn } from "./middlewares/llm.ts";
import { toolMiddleware } from "./middlewares/tool.ts";
import type { ExecuteToolFn } from "./middlewares/tool.ts";
import { memoryMiddleware } from "./middlewares/memory.ts";
import type { MemoryWriter } from "./middlewares/memory.ts";
import { observabilityMiddleware } from "./middlewares/observability.ts";
import type { ObservabilityDeps } from "./middlewares/observability.ts";
import { contextRefreshMiddleware } from "./middlewares/context_refresh.ts";
import type { ContextRefreshDeps } from "./middlewares/context_refresh.ts";
import { a2aTaskMiddleware } from "./middlewares/a2a_task.ts";
import type { A2ATaskDeps } from "./middlewares/a2a_task.ts";
import { analyticsMiddleware } from "./middlewares/analytics.ts";
import type { AnalyticsStore } from "../db/analytics.ts";
import { resolveAnalyticsStore } from "../db/analytics.ts";

// ── Runner ───────────────────────────────────────────

interface MemoryReader {
  getMessages(): Promise<Message[]>;
}

export class AgentRunner {
  constructor(
    private pipeline: MiddlewarePipeline,
    private eventStore: EventStore,
    private session: SessionState,
    private memory: MemoryReader,
  ) {}

  async run(input: KernelInput): Promise<AgentResponse> {
    const kernel = agentKernel(input);
    let next = await kernel.next();

    try {
      while (!next.done) {
        const event = next.value;
        await this.eventStore.commit(event);
        const resolution = await this.pipeline.execute(event, this.session);
        next = await kernel.next(resolution);
      }

      const finalEvent = next.value;
      await this.eventStore.commit(finalEvent);
      await this.pipeline.execute(finalEvent, this.session);
      return await this.toAgentResult(finalEvent);
    } catch (e) {
      // Commit a synthetic error event for auditing only — do NOT pass
      // through the pipeline (a2a middleware would double-report task state).
      // Trace cleanup is handled by observabilityMiddleware's own try/catch.
      const evt = createEventFactory();
      await this.eventStore.commit(evt<ErrorEvent>(
        {
          type: "error",
          code: "RUNNER_ERROR",
          context: { message: e instanceof Error ? e.message : String(e) },
        },
        0,
      )).catch(() => {});
      throw e;
    }
  }

  private async toAgentResult(event: FinalEvent): Promise<AgentResponse> {
    if (event.type === "complete") {
      return {
        content: event.content,
        finishReason: event.finishReason ?? "stop",
      };
    }

    // Structural errors (misconfigured pipeline) should surface loudly
    if (event.code === "MISSING_LLM_RESOLUTION" || event.code === "MISSING_TOOL_RESOLUTION") {
      throw new Error(`Kaku kernel: ${event.code} — ${event.recovery ?? "check pipeline"}`);
    }

    // Graceful degradation (max_iterations etc.)
    log.warn(`Agent kernel error: ${event.code}${event.recovery ? ` — ${event.recovery}` : ""}`);
    const messages = await this.memory.getMessages();
    const last = messages.findLast((m) => m.role === "assistant");
    return {
      content: last?.content ??
        "Max iterations reached without a final response.",
      finishReason: event.code,
    };
  }
}

// ── Factory return type ──────────────────────────────

export interface RunnerBundle {
  runner: AgentRunner;
  session: SessionState;
  kernelInput: KernelInput;
}

// ── Factory: Local runner ────────────────────────────

export interface LocalRunnerDeps {
  agentId: string;
  sessionId: string;
  taskId?: string;
  memoryTopics: string[];
  memoryFiles: string[];
  memory: MemoryWriter & MemoryReader;
  complete: CompleteFn;
  executeTool: ExecuteToolFn;
  observability: ObservabilityDeps;
  contextRefresh: ContextRefreshDeps;
  analytics?: AnalyticsStore | null;
  /** Build context messages using current memoryTopics/memoryFiles from session. */
  buildMessages: (
    memoryTopics: string[],
    memoryFiles: string[],
  ) => Promise<Message[]>;
  toolDefinitions: ToolDefinition[];
  llmConfig: AgentConfig;
  maxIterations: number;
}

export function createLocalRunner(deps: LocalRunnerDeps): RunnerBundle {
  const session: SessionState = {
    agentId: deps.agentId,
    sessionId: deps.sessionId,
    taskId: deps.taskId,
    memoryTopics: deps.memoryTopics,
    memoryFiles: deps.memoryFiles,
  };
  const analytics = resolveAnalyticsStore(deps.analytics);

  // getMessages reads session.memoryTopics/memoryFiles so context refreshes
  // applied by contextRefreshMiddleware are visible on the next iteration.
  const getMessages: GetMessagesFn = () =>
    deps.buildMessages(session.memoryTopics, session.memoryFiles);

  const pipeline = new MiddlewarePipeline()
    .use(observabilityMiddleware(deps.observability))
    .use(memoryMiddleware(deps.memory))
    .use(contextRefreshMiddleware(deps.contextRefresh));

  if (analytics) {
    pipeline.use(analyticsMiddleware({ analytics }));
  }

  pipeline
    .use(toolMiddleware(deps.executeTool))
    .use(llmMiddleware({ getMessages, complete: deps.complete }));

  return {
    runner: new AgentRunner(
      pipeline,
      new InMemoryEventStore(),
      session,
      deps.memory,
    ),
    session,
    kernelInput: {
      toolDefinitions: deps.toolDefinitions,
      llmConfig: deps.llmConfig,
      maxIterations: deps.maxIterations,
    },
  };
}

// ── Factory: Broker runner ───────────────────────────

export interface BrokerRunnerDeps {
  agentId: string;
  canonicalTask: Task;
  memoryFiles: string[];
  runtimeGrants?: AgentRuntimeGrant[];
  memory: MemoryWriter & MemoryReader;
  complete: CompleteFn;
  executeTool: ExecuteToolFn;
  contextRefresh: ContextRefreshDeps;
  a2aTask: A2ATaskDeps;
  analytics?: AnalyticsStore | null;
  /** Build context messages using current memoryTopics/memoryFiles from session. */
  buildMessages: (
    memoryTopics: string[],
    memoryFiles: string[],
  ) => Promise<Message[]>;
  toolDefinitions: ToolDefinition[];
  llmConfig: AgentConfig;
  maxIterations: number;
}

/**
 * No observabilityMiddleware in the broker pipeline — the broker runtime
 * currently has no TraceWriter dependency. Add it here when broker tracing
 * is implemented.
 */
export function createBrokerRunner(deps: BrokerRunnerDeps): RunnerBundle {
  const session: SessionState = {
    agentId: deps.agentId,
    sessionId: `agent:${deps.canonicalTask.contextId ?? deps.canonicalTask.id}`,
    taskId: deps.canonicalTask.id,
    memoryTopics: [],
    memoryFiles: deps.memoryFiles,
    canonicalTask: deps.canonicalTask,
    runtimeGrants: deps.runtimeGrants,
  };
  const analytics = resolveAnalyticsStore(deps.analytics);

  const getMessages: GetMessagesFn = () =>
    deps.buildMessages(session.memoryTopics, session.memoryFiles);

  const pipeline = new MiddlewarePipeline()
    .use(memoryMiddleware(deps.memory))
    .use(contextRefreshMiddleware(deps.contextRefresh));

  if (analytics) {
    pipeline.use(analyticsMiddleware({ analytics }));
  }

  pipeline
    .use(a2aTaskMiddleware(deps.a2aTask))
    .use(toolMiddleware(deps.executeTool))
    .use(llmMiddleware({ getMessages, complete: deps.complete }));

  return {
    runner: new AgentRunner(
      pipeline,
      new InMemoryEventStore(),
      session,
      deps.memory,
    ),
    session,
    kernelInput: {
      toolDefinitions: deps.toolDefinitions,
      llmConfig: deps.llmConfig,
      maxIterations: deps.maxIterations,
    },
  };
}
