import type {
  AgentConfig,
  AgentDefaults,
  AgentResponse,
  ToolsConfig,
} from "./types.ts";
import type { SandboxConfig } from "../shared/types.ts";
import type { ProvidersConfig } from "../llm/types.ts";
import { ProviderManager } from "../llm/manager.ts";
import { createSandboxBackend } from "./tools/backends/factory.ts";

/** Projection minimale de Config nécessaire à AgentLoop — pas de dépendance sur config/ */
interface AgentLoopConfig {
  agents: { defaults: AgentDefaults };
  providers: ProvidersConfig;
  tools?: ToolsConfig;
}
import { Memory } from "./memory.ts";
import type { MemoryPort } from "./memory_port.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ShellTool } from "./tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "./tools/file.ts";
import { WebFetchTool } from "./tools/web.ts";
import { SendToAgentTool } from "./tools/send_to_agent.ts";
import type { SendToAgentFn } from "./tools/send_to_agent.ts";
import { MemoryTool } from "./tools/memory.ts";
import { log } from "../shared/log.ts";
import { spanAgentLoop, spanToolCall } from "../telemetry/mod.ts";
import type {
  TraceCorrelationIds,
  TraceWriter,
} from "../telemetry/traces.ts";

import type { ApprovalRequest, ApprovalResponse } from "../shared/types.ts";

export type AskApprovalFn = (req: ApprovalRequest) => Promise<ApprovalResponse>;

export interface AgentLoopLike {
  processMessage(userMessage: string): Promise<AgentResponse>;
  close(): Promise<void>;
}

export interface AgentLoopFactoryContext {
  sessionId: string;
  model?: string;
  traceId?: string;
  taskId: string;
  contextId: string;
  askApproval?: AskApprovalFn;
}

export interface AgentLoopDeps {
  providers?: ProviderManager;
  memory?: MemoryPort;
  tools?: ToolRegistry;
  sendToAgent?: SendToAgentFn;
  availablePeers?: string[];
  sandboxConfig?: SandboxConfig;
  askApproval?: AskApprovalFn;
  traceWriter?: TraceWriter;
  traceId?: string;
  taskId?: string;
  contextId?: string;
  agentId?: string;
}

export class AgentLoop implements AgentLoopLike {
  private config: AgentConfig;
  private providers: ProviderManager;
  private memory: MemoryPort;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private tools: ToolRegistry;
  private maxIterations: number;
  private traceWriter: TraceWriter | null;
  private traceId: string | undefined;
  private taskId: string | undefined;
  private contextId: string | undefined;
  private agentId: string;
  private sessionId: string;

  constructor(
    sessionId: string,
    config: AgentLoopConfig,
    agentConfig?: Partial<AgentConfig>,
    maxIterations = 10,
    deps?: AgentLoopDeps,
  ) {
    this.config = {
      model: config.agents?.defaults?.model || "anthropic/claude-sonnet-4-6",
      temperature: config.agents?.defaults?.temperature ?? 0.7,
      maxTokens: config.agents?.defaults?.maxTokens ?? 4096,
      systemPrompt: config.agents?.defaults?.systemPrompt,
      ...agentConfig,
    };

    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.memory = deps?.memory ?? new Memory(sessionId);
    this.tools = deps?.tools ?? new ToolRegistry();
    this.context = new ContextBuilder(this.config);
    this.skills = new SkillsLoader();
    this.maxIterations = maxIterations;
    this.traceWriter = deps?.traceWriter ?? null;
    this.traceId = deps?.traceId;
    this.taskId = deps?.taskId;
    this.contextId = deps?.contextId ?? deps?.taskId;
    this.agentId = deps?.agentId ?? sessionId;
    this.sessionId = sessionId;

    if (!deps?.tools) this.registerBuiltInTools(config);
    if (deps?.sendToAgent) {
      this.tools.register(
        new SendToAgentTool(deps.sendToAgent, deps.availablePeers),
      );
    }
    this.tools.register(new MemoryTool(this.memory));
    if (deps?.sandboxConfig) {
      const backend = createSandboxBackend(deps.sandboxConfig);
      this.tools.setBackend(
        backend,
        deps.sandboxConfig.execPolicy,
        config.tools,
        deps.sandboxConfig.networkAllow,
      );
      if (deps.askApproval) this.tools.setAskApproval(deps.askApproval);
    }
  }

  private registerBuiltInTools(config: AgentLoopConfig): void {
    const t = config.tools;
    this.tools.register(new ShellTool(t?.restrictToWorkspace));
    this.tools.register(new ReadFileTool());
    this.tools.register(new WriteFileTool());
    this.tools.register(new WebFetchTool());
  }

  private memoryTopics: string[] = [];

  async initialize(): Promise<void> {
    await this.memory.load();
    await this.skills.loadSkills();
    this.memoryTopics = await this.memory.listTopics();
  }

  async processMessage(userMessage: string): Promise<AgentResponse> {
    await this.initialize();
    await this.memory.addMessage({ role: "user", content: userMessage });

    // Start KV trace if writer available
    const tw = this.traceWriter;
    let traceId = this.traceId;
    const correlationIds: TraceCorrelationIds = {
      ...(this.taskId ? { taskId: this.taskId } : {}),
      ...(this.contextId ? { contextId: this.contextId } : {}),
    };
    if (tw && !traceId) {
      traceId = await tw.startTrace(this.agentId, this.sessionId, correlationIds);
    }

    let iteration = 0;
    let finalStatus: "completed" | "failed" = "completed";

    try {
      while (iteration < this.maxIterations) {
        iteration++;

        // KV trace: iteration span
        const iterSpanId = tw && traceId
          ? await tw.writeIterationSpan(
            traceId,
            this.agentId,
            iteration,
            undefined,
            correlationIds,
          )
          : null;
        const iterStart = performance.now();

        // OTEL span (parallel, independent)
        const iterResult = await spanAgentLoop(
          this.sessionId,
          iteration,
          async () => {
            log.debug(
              `Boucle agent itération ${iteration}/${this.maxIterations}`,
            );

            const skillsList = this.skills.getSkills();
            const toolDefs = this.tools.getDefinitions();
            const raw = this.context.buildContextMessages(
              this.memory.getMessages(),
              skillsList,
              toolDefs,
              this.memoryTopics,
            );

            const CHARS_PER_TOKEN = 4;
            const CONTEXT_RATIO = 4;
            const maxChars = (this.config.maxTokens || 4096) * CHARS_PER_TOKEN *
              CONTEXT_RATIO;
            const contextMessages = this.context.truncateContext(raw, maxChars);

            // LLM call with timing
            const llmStart = performance.now();
            const response = await this.providers.complete(
              contextMessages,
              this.config.model,
              this.config.temperature,
              this.config.maxTokens,
              toolDefs,
            );
            const llmLatency = performance.now() - llmStart;

            // KV trace: LLM span
            if (tw && traceId && iterSpanId) {
              const provider = this.config.model.includes("/")
                ? this.config.model.split("/")[0]
                : this.config.model;
              await tw.writeLLMSpan(
                traceId,
                this.agentId,
                iterSpanId,
                this.config.model,
                provider,
                {
                  prompt: response.usage?.promptTokens ?? 0,
                  completion: response.usage?.completionTokens ?? 0,
                },
                llmLatency,
                correlationIds,
              );
            }

            log.debug(
              `LLM: content=${!!response.content} tools=${
                response.toolCalls?.length ?? 0
              }`,
            );

            if (response.toolCalls?.length) {
              await this.memory.addMessage({
                role: "assistant",
                content: response.content || "",
                tool_calls: response.toolCalls,
              });

              for (const tc of response.toolCalls) {
                let args: Record<string, unknown>;
                try {
                  args = JSON.parse(tc.function.arguments);
                } catch {
                  log.warn(`JSON invalide pour outil ${tc.function.name}`);
                  await this.memory.addMessage({
                    role: "tool",
                    content:
                      `Error: Invalid JSON arguments for ${tc.function.name}`,
                    name: tc.function.name,
                    tool_call_id: tc.id,
                  });
                  continue;
                }

                log.info(`Outil: ${tc.function.name}`);
                const toolStart = performance.now();
                const result = await spanToolCall(
                  tc.function.name,
                  () => this.tools.execute(tc.function.name, args),
                );
                const toolLatency = performance.now() - toolStart;

                // KV trace: tool span
                if (tw && traceId && iterSpanId) {
                  await tw.writeToolSpan(
                    traceId,
                    this.agentId,
                    iterSpanId,
                    tc.function.name,
                    result.success,
                    toolLatency,
                    args,
                    correlationIds,
                  );
                }

                await this.memory.addMessage({
                  role: "tool",
                  content: result.success
                    ? result.output
                    : `Error [${result.error?.code}]: ${
                      JSON.stringify(result.error?.context)
                    }\nRecovery: ${result.error?.recovery ?? "none"}`,
                  name: tc.function.name,
                  tool_call_id: tc.id,
                });
              }

              return null; // continue loop
            }

            // Final text response
            await this.memory.addMessage({
              role: "assistant",
              content: response.content,
            });
            return {
              content: response.content,
              finishReason: response.finishReason,
            } as AgentResponse;
          },
        );

        // KV trace: end iteration span
        if (tw && traceId && iterSpanId) {
          await tw.endSpan(traceId, iterSpanId, performance.now() - iterStart);
        }

        if (iterResult !== null) return iterResult;
      }

      log.warn(`Max itérations atteint (${this.maxIterations})`);
      finalStatus = "completed";
      const last = this.memory.getMessages().findLast((m) =>
        m.role === "assistant"
      );
      return {
        content: last?.content ||
          "Max iterations reached without a final response.",
        finishReason: "max_iterations",
      };
    } catch (e) {
      finalStatus = "failed";
      throw e;
    } finally {
      // KV trace: end trace
      if (tw && traceId) {
        await tw.endTrace(traceId, finalStatus, iteration).catch(() => {});
      }
    }
  }

  getMemory(): MemoryPort {
    return this.memory;
  }

  getTools(): ToolRegistry {
    return this.tools;
  }

  async close(): Promise<void> {
    await this.tools.close();
    this.memory.close();
  }
}
