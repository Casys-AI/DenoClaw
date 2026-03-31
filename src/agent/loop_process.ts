import type { ProviderManager } from "../llm/manager.ts";
import { spanAgentLoop, spanToolCall } from "../telemetry/mod.ts";
import type { TraceCorrelationIds, TraceWriter } from "../telemetry/traces.ts";
import { log } from "../shared/log.ts";
import type { AgentConfig, AgentResponse } from "./types.ts";
import type { ContextBuilder } from "./context.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { SkillsLoader } from "./skills.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";

export interface ProcessAgentLoopMessageInput {
  userMessage: string;
  config: AgentConfig;
  providers: ProviderManager;
  memory: MemoryPort;
  context: ContextBuilder;
  skills: SkillsLoader;
  tools: ToolRegistry;
  memoryTopics: string[];
  memoryFiles: string[];
  getRuntimeGrants?: () => AgentRuntimeGrant[];
  maxIterations: number;
  traceWriter: TraceWriter | null;
  traceId?: string;
  taskId?: string;
  contextId?: string;
  agentId: string;
  sessionId: string;
}

export async function processAgentLoopMessage(
  input: ProcessAgentLoopMessageInput,
): Promise<AgentResponse> {
  await input.memory.addMessage({ role: "user", content: input.userMessage });

  const correlationIds: TraceCorrelationIds = {
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.contextId ? { contextId: input.contextId } : {}),
  };
  let traceId = input.traceId;
  if (input.traceWriter && !traceId) {
    traceId = await input.traceWriter.startTrace(
      input.agentId,
      input.sessionId,
      correlationIds,
    );
  }

  let iteration = 0;
  let finalStatus: "completed" | "failed" = "completed";

  try {
    while (iteration < input.maxIterations) {
      iteration++;

      const iterSpanId = input.traceWriter && traceId
        ? await input.traceWriter.writeIterationSpan(
          traceId,
          input.agentId,
          iteration,
          undefined,
          correlationIds,
        )
        : null;
      const iterStart = performance.now();

      const iterResult = await spanAgentLoop(
        input.sessionId,
        iteration,
        async () => {
          log.debug(
            `Agent loop iteration ${iteration}/${input.maxIterations}`,
          );

          const raw = input.context.buildContextMessages(
            input.memory.getMessages(),
            input.skills.getSkills(),
            input.tools.getDefinitions(),
            input.memoryTopics,
            input.memoryFiles,
            input.getRuntimeGrants?.() ?? [],
          );

          const CHARS_PER_TOKEN = 4;
          const CONTEXT_RATIO = 4;
          const maxChars = (input.config.maxTokens || 4096) * CHARS_PER_TOKEN *
            CONTEXT_RATIO;
          const contextMessages = input.context.truncateContext(raw, maxChars);

          const llmStart = performance.now();
          const response = await input.providers.complete(
            contextMessages,
            input.config.model,
            input.config.temperature,
            input.config.maxTokens,
            input.tools.getDefinitions(),
          );
          const llmLatency = performance.now() - llmStart;

          if (input.traceWriter && traceId && iterSpanId) {
            const provider = input.config.model.includes("/")
              ? input.config.model.split("/")[0]
              : input.config.model;
            await input.traceWriter.writeLLMSpan(
              traceId,
              input.agentId,
              iterSpanId,
              input.config.model,
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
            await input.memory.addMessage({
              role: "assistant",
              content: response.content || "",
              tool_calls: response.toolCalls,
            });

            for (const tc of response.toolCalls) {
              let args: Record<string, unknown>;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                log.warn(`Invalid JSON for tool ${tc.function.name}`);
                await input.memory.addMessage({
                  role: "tool",
                  content:
                    `Error: Invalid JSON arguments for ${tc.function.name}`,
                  name: tc.function.name,
                  tool_call_id: tc.id,
                });
                continue;
              }

              log.info(`Tool: ${tc.function.name}`);
              const toolStart = performance.now();
              const result = await spanToolCall(
                tc.function.name,
                () => input.tools.execute(tc.function.name, args),
              );
              const toolLatency = performance.now() - toolStart;

              if (input.traceWriter && traceId && iterSpanId) {
                await input.traceWriter.writeToolSpan(
                  traceId,
                  input.agentId,
                  iterSpanId,
                  tc.function.name,
                  result.success,
                  toolLatency,
                  args,
                  correlationIds,
                );
              }

              await input.memory.addMessage({
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

            return null;
          }

          await input.memory.addMessage({
            role: "assistant",
            content: response.content,
          });
          return {
            content: response.content,
            finishReason: response.finishReason,
          } as AgentResponse;
        },
      );

      if (input.traceWriter && traceId && iterSpanId) {
        await input.traceWriter.endSpan(
          traceId,
          iterSpanId,
          performance.now() - iterStart,
        );
      }

      if (iterResult !== null) return iterResult;
    }

    log.warn(`Max iterations reached (${input.maxIterations})`);
    finalStatus = "completed";
    const last = input.memory.getMessages().findLast((message) =>
      message.role === "assistant"
    );
    return {
      content: last?.content ||
        "Max iterations reached without a final response.",
      finishReason: "max_iterations",
    };
  } catch (error) {
    finalStatus = "failed";
    throw error;
  } finally {
    if (input.traceWriter && traceId) {
      await input.traceWriter.endTrace(traceId, finalStatus, iteration).catch(
        () => {},
      );
    }
  }
}
