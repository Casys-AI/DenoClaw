import {
  mapApprovalPauseToInputRequiredTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../messaging/a2a/task_mapping.ts";
import { transitionTask } from "../messaging/a2a/internal_contract.ts";
import type { Task } from "../messaging/a2a/types.ts";
import { log } from "../shared/log.ts";
import type { AgentLlmToolPort } from "../shared/types.ts";
import type { ContextBuilder } from "./context.ts";
import type { MemoryPort } from "./memory_port.ts";
import { extractRuntimeApprovalPause } from "./runtime_message_mapping.ts";
import type { SkillsLoader } from "./skills.ts";
import type { AgentConfig } from "./types.ts";

export interface ExecuteAgentConversationInput {
  config: AgentConfig;
  llmToolPort: AgentLlmToolPort;
  context: ContextBuilder;
  skills: SkillsLoader;
  memory: MemoryPort;
  fromAgentId: string;
  inputText: string;
  canonicalTask: Task;
  reportWorkingTransition: boolean;
  maxIterations: number;
  reportTaskResult(task: Task): Promise<void>;
}

export async function executeAgentConversation(
  input: ExecuteAgentConversationInput,
): Promise<void> {
  let canonicalTask = input.canonicalTask;

  if (input.reportWorkingTransition) {
    canonicalTask = transitionTask(canonicalTask, "WORKING");
    await input.reportTaskResult(canonicalTask);
  }

  await input.memory.addMessage({ role: "user", content: input.inputText });

  try {
    let iteration = 0;
    while (iteration < input.maxIterations) {
      iteration++;

      const contextMessages = input.context.buildContextMessages(
        input.memory.getMessages(),
        input.skills.getSkills(),
        [],
      );

      const response = await input.llmToolPort.complete(
        contextMessages,
        input.config.model,
        input.config.temperature,
        input.config.maxTokens,
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

          const approvalPause = extractRuntimeApprovalPause(result);
          if (approvalPause) {
            await input.memory.addMessage({
              role: "tool",
              content:
                `Approval required [${approvalPause.reason}]: ${approvalPause.command}`,
              name: tc.function.name,
              tool_call_id: tc.id,
            });
            await input.reportTaskResult(
              mapApprovalPauseToInputRequiredTask(canonicalTask, {
                command: approvalPause.command,
                binary: approvalPause.binary,
                prompt: approvalPause.prompt,
              }),
            );
            log.info(
              `Canonical task paused in INPUT_REQUIRED for ${input.fromAgentId}`,
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
