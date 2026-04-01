import {
  mapPrivilegeElevationPauseToInputRequiredTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../messaging/a2a/task_mapping.ts";
import { transitionTask } from "../messaging/a2a/internal_contract.ts";
import type { Task } from "../messaging/a2a/types.ts";
import { log } from "../shared/log.ts";
import type { AgentLlmToolPort, ToolDefinition } from "../shared/types.ts";
import type { ContextBuilder } from "./context.ts";
import type { MemoryPort } from "./memory_port.ts";
import {
  extractRuntimePrivilegeElevationPause,
} from "./runtime_message_mapping.ts";
import type { SkillLoader } from "./skills.ts";
import type { AgentConfig } from "./types.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";
import {
  applyConversationContextRefresh,
  createConversationContextRefreshState,
} from "./conversation_context_refresh.ts";

export interface ExecuteAgentConversationInput {
  config: AgentConfig;
  llmToolPort: AgentLlmToolPort;
  tools: ToolDefinition[];
  context: ContextBuilder;
  skills: SkillLoader;
  memory: MemoryPort;
  fromAgentId: string;
  inputText: string;
  canonicalTask: Task;
  memoryTopics?: string[];
  memoryFiles?: string[];
  refreshMemoryFiles?: () => Promise<string[]>;
  getRuntimeGrants?: () => AgentRuntimeGrant[];
  reportWorkingTransition: boolean;
  maxIterations: number;
  reportTaskResult(task: Task): Promise<void>;
}

export async function executeAgentConversation(
  input: ExecuteAgentConversationInput,
): Promise<void> {
  let canonicalTask = input.canonicalTask;
  let memoryTopics = input.memoryTopics;
  let memoryFiles = input.memoryFiles;

  if (input.reportWorkingTransition) {
    canonicalTask = transitionTask(canonicalTask, "WORKING");
    await input.reportTaskResult(canonicalTask);
  }

  if (input.inputText.trim().length > 0) {
    await input.memory.addMessage({ role: "user", content: input.inputText });
  }

  try {
    let iteration = 0;
    while (iteration < input.maxIterations) {
      iteration++;

      const contextMessages = input.context.buildContextMessages(
        input.memory.getMessages(),
        input.skills.getSkills(),
        input.tools,
        memoryTopics,
        memoryFiles,
        input.getRuntimeGrants?.() ?? [],
      );

      const response = await input.llmToolPort.complete(
        contextMessages,
        input.config.model,
        input.config.temperature,
        input.config.maxTokens,
        input.tools,
      );

      if (response.toolCalls?.length) {
        await input.memory.addMessage({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });
        const refreshState = createConversationContextRefreshState();

        for (const tc of response.toolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            await input.memory.addMessage({
              role: "tool",
              content:
                `Error [INVALID_JSON]: bad arguments for ${tc.function.name}`,
              name: tc.function.name,
              tool_call_id: tc.id,
            });
            continue;
          }

          const result = await input.llmToolPort.execTool(
            tc.function.name,
            args,
            {
              taskId: canonicalTask.id,
              contextId: canonicalTask.contextId,
            },
          );

          const privilegePause = extractRuntimePrivilegeElevationPause(result);
          if (privilegePause) {
            await input.reportTaskResult(
              mapPrivilegeElevationPauseToInputRequiredTask(canonicalTask, {
                grants: privilegePause.grants,
                scope: privilegePause.scope,
                prompt: privilegePause.prompt,
                command: privilegePause.command,
                binary: privilegePause.binary,
                pendingTool: {
                  tool: tc.function.name,
                  args,
                  toolCallId: tc.id,
                },
                expiresAt: privilegePause.expiresAt,
              }),
            );
            log.info(
              `Canonical task paused in INPUT_REQUIRED for privilege elevation (${input.fromAgentId})`,
            );
            return;
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
          applyConversationContextRefresh(
            refreshState,
            tc.function.name,
            args,
            result,
          );
        }

        if (refreshState.reloadSkills) {
          await input.skills.reload();
        }
        if (refreshState.reloadMemoryFiles && input.refreshMemoryFiles) {
          memoryFiles = await input.refreshMemoryFiles();
        }
        if (refreshState.reloadMemoryTopics) {
          memoryTopics = await input.memory.listTopics();
        }

        continue;
      }

      await input.memory.addMessage({
        role: "assistant",
        content: response.content,
      });

      await input.reportTaskResult(
        mapTaskResultToCompletion(canonicalTask, response.content),
      );
      log.info(
        `Canonical task completed for ${input.fromAgentId} (${iteration} iterations)`,
      );
      return;
    }

    await input.reportTaskResult(
      mapTaskErrorToTerminalStatus(
        canonicalTask,
        new Error("Max iterations reached."),
      ),
    );
  } catch (error) {
    await input.reportTaskResult(
      mapTaskErrorToTerminalStatus(canonicalTask, error),
    );
    throw error;
  }
}
