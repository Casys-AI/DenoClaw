import type {
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskSubmitPayload,
  LLMRequest,
  ToolRequest,
  ToolResponsePayload,
} from "./types.ts";
import { isBrokerErrorMessage } from "./types.ts";
import type {
  AgentBrokerPort,
  LLMResponse,
  Message,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import type { BrokerTransport } from "./transport.ts";
import { KvQueueTransport } from "./transport.ts";
import { DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";

export interface BrokerClientDeps {
  kv?: Deno.Kv;
  transport?: BrokerTransport;
}

/**
 * BrokerClient — used by agents to communicate with the Broker.
 *
 * Transport is pluggable via BrokerTransport (KV Queue locally, HTTP/SSE on network).
 * The client operates in canonical task terms above the transport layer.
 */
export class BrokerClient implements AgentBrokerPort {
  private transport: BrokerTransport;

  constructor(agentId: string, deps: BrokerClientDeps = {}) {
    if (deps.kv && deps.transport) {
      throw new DenoClawError(
        "INVALID_BROKER_CLIENT_DEPS",
        {},
        "Provide either 'kv' or 'transport', not both",
      );
    }
    this.transport = deps.transport ??
      new KvQueueTransport(agentId, { kv: deps.kv });
  }

  private unwrapOrThrow(response: BrokerMessage): BrokerMessage {
    if (isBrokerErrorMessage(response)) {
      throw new DenoClawError(
        response.payload.code,
        response.payload.context,
        response.payload.recovery,
      );
    }
    return response;
  }

  // ── Lifecycle ───────────────────────────────────────

  async startListening(): Promise<void> {
    await this.transport.start();
  }

  close(): void {
    this.transport.close();
  }

  // ── LLM ─────────────────────────────────────────────

  async complete(
    messages: Message[],
    model: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const payload: LLMRequest = {
      messages,
      model,
      temperature,
      maxTokens,
      tools,
    };
    const response = this.unwrapOrThrow(
      await this.transport.send({ to: "broker", type: "llm_request", payload }),
    );

    if (response.type !== "llm_response") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "llm_response", actual: response.type },
        "Check broker/client message contract",
      );
    }

    return response.payload as LLMResponse;
  }

  // ── Tool execution ──────────────────────────────────

  async execTool(
    tool: string,
    args: Record<string, unknown>,
    correlation?: { taskId?: string; contextId?: string },
  ): Promise<ToolResult> {
    const payload: ToolRequest = { tool, args, ...correlation };
    const response = await this.transport.send({
      to: "broker",
      type: "tool_request",
      payload,
    });

    if (response.type === "error") {
      return {
        success: false,
        output: "",
        error: response.payload,
      };
    }

    if (response.type !== "tool_response") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "tool_response", actual: response.type },
        "Check broker/client message contract",
      );
    }

    return response.payload as ToolResponsePayload;
  }

  // ── Canonical task operations ───────────────────────

  async submitTask(payload: BrokerTaskSubmitPayload): Promise<Task> {
    const response = this.unwrapOrThrow(
      await this.transport.send({
        to: "broker",
        type: "task_submit",
        payload,
      }),
    );

    if (response.type !== "task_result") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "task_result", actual: response.type },
        "Check broker/client task contract",
      );
    }

    if (!response.payload.task) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: payload.taskId },
        "Task submission did not return a persisted task",
      );
    }

    return response.payload.task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return await this.requestTaskResult({ taskId }, "task_get");
  }

  async continueTask(payload: BrokerTaskContinuePayload): Promise<Task | null> {
    const response = this.unwrapOrThrow(
      await this.transport.send({ to: "broker", type: "task_continue", payload }),
    );

    if (response.type !== "task_result") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "task_result", actual: response.type },
        "Check broker/client task contract",
      );
    }

    return response.payload.task;
  }

  async cancelTask(taskId: string): Promise<Task | null> {
    return await this.requestTaskResult({ taskId }, "task_cancel");
  }

  async reportTaskResult(task: Task): Promise<Task> {
    const response = this.unwrapOrThrow(
      await this.transport.send({
        to: "broker",
        type: "task_result",
        payload: { task },
      }),
    );

    if (response.type !== "task_result") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "task_result", actual: response.type },
        "Check broker/client task contract",
      );
    }

    if (!response.payload.task) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: task.id },
        "Broker did not return a persisted task",
      );
    }

    return response.payload.task;
  }

  private async requestTaskResult(
    payload: BrokerTaskQueryPayload,
    type: "task_get" | "task_cancel",
  ): Promise<Task | null> {
    const response = this.unwrapOrThrow(
      await this.transport.send({ to: "broker", type, payload }),
    );

    if (response.type !== "task_result") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "task_result", actual: response.type },
        "Check broker/client task contract",
      );
    }

    return response.payload.task;
  }

  // ── Inter-agent ─────────────────────────────────────

  async sendTextTask(
    targetAgentId: string,
    instruction: string,
    options: {
      taskId?: string;
      contextId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<Task> {
    return await this.submitTask({
      targetAgent: targetAgentId,
      taskId: options.taskId ?? generateId(),
      contextId: options.contextId,
      metadata: options.metadata,
      message: {
        messageId: generateId(),
        role: "user",
        parts: [{ kind: "text", text: instruction }],
      } as A2AMessage,
    });
  }
}
