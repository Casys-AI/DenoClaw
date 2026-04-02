import type { Message, ToolDefinition } from "../shared/types.ts";
import type { AgentConfig } from "./types.ts";
import type {
  AgentEvent,
  CompleteEvent,
  ErrorEvent,
  EventResolution,
  FinalEvent,
  LlmResolution,
  ToolResolution,
} from "./events.ts";
import { createEventFactory } from "./events.ts";
import { log } from "../shared/log.ts";

export interface KernelInput {
  getMessages: () => Message[];
  toolDefinitions: ToolDefinition[];
  llmConfig: AgentConfig;
  maxIterations: number;
}

export async function* agentKernel(
  input: KernelInput,
): AsyncGenerator<AgentEvent, FinalEvent, EventResolution | undefined> {
  const event = createEventFactory();
  let iteration = 0;

  while (iteration < input.maxIterations) {
    iteration++;

    // 1. Request LLM call
    const rawLlm = yield event<AgentEvent>(
      {
        type: "llm_request",
        messages: input.getMessages(),
        tools: input.toolDefinitions,
        config: input.llmConfig,
      },
      iteration,
    );

    if (!rawLlm || (rawLlm as { type?: string }).type !== "llm") {
      return event<ErrorEvent>(
        {
          type: "error",
          code: "MISSING_LLM_RESOLUTION",
          context: { received: rawLlm ? (rawLlm as { type?: string }).type : "undefined" },
          recovery: "Ensure llmMiddleware is registered in the pipeline",
        },
        iteration,
      );
    }
    const llmResolution = rawLlm as LlmResolution;

    // 2. Observe LLM response
    yield event<AgentEvent>(
      {
        type: "llm_response",
        content: llmResolution.content,
        toolCalls: llmResolution.toolCalls,
        usage: llmResolution.usage,
      },
      iteration,
    );

    // 3. Tool calls
    if (llmResolution.toolCalls?.length) {
      for (const tc of llmResolution.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          // Invalid JSON — log, yield error tool_result and skip
          log.warn(`Invalid JSON for tool ${tc.function.name}: ${tc.function.arguments.slice(0, 200)}`);
          yield event<AgentEvent>(
            {
              type: "tool_result",
              callId: tc.id,
              name: tc.function.name,
              arguments: {},
              result: {
                success: false,
                output: `Invalid JSON arguments for ${tc.function.name}: ${tc.function.arguments.slice(0, 200)}`,
                error: {
                  code: "INVALID_JSON",
                  context: { tool: tc.function.name, raw: tc.function.arguments.slice(0, 200) },
                  recovery: "Fix the JSON syntax in your arguments",
                },
              },
            },
            iteration,
          );
          continue;
        }

        // Request tool execution
        const rawTool = yield event<AgentEvent>(
          {
            type: "tool_call",
            callId: tc.id,
            name: tc.function.name,
            arguments: args,
          },
          iteration,
        );

        if (!rawTool || (rawTool as { type?: string }).type !== "tool") {
          return event<ErrorEvent>(
            {
              type: "error",
              code: "MISSING_TOOL_RESOLUTION",
              context: { tool: tc.function.name, received: rawTool ? (rawTool as { type?: string }).type : "undefined" },
              recovery: "Ensure toolMiddleware is registered in the pipeline",
            },
            iteration,
          );
        }
        const toolResolution = rawTool as ToolResolution;

        // Observe tool result
        yield event<AgentEvent>(
          {
            type: "tool_result",
            callId: tc.id,
            name: tc.function.name,
            arguments: args,
            result: toolResolution.result,
          },
          iteration,
        );
      }
      continue; // Next iteration
    }

    // 4. No tool calls — final answer
    return event<CompleteEvent>(
      { type: "complete", content: llmResolution.content, finishReason: llmResolution.finishReason },
      iteration,
    );
  }

  // Max iterations reached
  return event<ErrorEvent>(
    {
      type: "error",
      code: "max_iterations",
      context: { iteration, maxIterations: input.maxIterations },
      recovery: "increase limit or simplify task",
    },
    iteration,
  );
}
