import type {
  AgentMessagePayload,
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskSubmitPayload,
  BrokerTaskSubmitMessage,
  LLMRequest,
  ToolRequest,
  ToolResponsePayload,
} from "./types.ts";
import { isBrokerErrorMessage } from "./types.ts";
import type {
  AgentBrokerPort,
  BrokerEnvelope,
  LLMResponse,
  Message,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";

export interface BrokerClientDeps {
  kv?: Deno.Kv;
}

/**
 * BrokerClient — used by agents in Subhosting to communicate with the Broker on Deploy.
 *
 * In local mode: calls providers/tools directly (pass-through).
 * In Subhosting mode: uses the broker-facing transport configured for the current runtime.
 */
export class BrokerClient implements AgentBrokerPort {
  private agentId: string;
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private pendingRequests = new Map<string, {
    resolve: (value: BrokerMessage) => void;
    reject: (reason: unknown) => void;
  }>();
  private listening = false;

  constructor(agentId: string, deps: BrokerClientDeps = {}) {
    this.agentId = agentId;
    this.kv = deps.kv ?? null;
    this.ownsKv = !deps.kv;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      this.kv = await Deno.openKv();
    }
    return this.kv;
  }

  /**
   * Start listening for responses from the broker.
   */
  async startListening(): Promise<void> {
    if (this.listening) return;
    this.listening = true;

    const kv = await this.getKv();
    kv.listenQueue((raw: unknown) => {
      const msg = raw as BrokerMessage;
      if (msg.to !== this.agentId) return;

      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        pending.resolve(msg);
        this.pendingRequests.delete(msg.id);
      } else {
        log.debug(`Message non attendu : ${msg.type} (${msg.id})`);
      }
    });

    log.info(`BrokerClient: écoute démarrée (agent: ${this.agentId})`);
  }

  /**
   * Send a typed message to the broker and wait for a correlated response.
   */
  private async request<TRequest extends BrokerMessage>(
    message: Omit<TRequest, "id" | "from" | "timestamp">,
    timeoutMs = 120_000,
  ): Promise<BrokerMessage> {
    const kv = await this.getKv();
    const id = generateId();

    const msg = {
      ...message,
      id,
      from: this.agentId,
      timestamp: new Date().toISOString(),
    } as BrokerMessage;

    const promise = new Promise<BrokerMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(
            new DenoClawError(
              "BROKER_TIMEOUT",
              { type: msg.type, to: msg.to, timeoutMs },
              "Broker did not respond in time. Check broker is running.",
            ),
          );
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeoutId);
          reject(reason);
        },
      });
    });

    await kv.enqueue(msg);
    log.debug(`Requête envoyée au broker : ${msg.type} (${id})`);

    return promise;
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

  // ── LLM ─────────────────────────────────────────────

  /**
   * Request LLM completion via the broker.
   * The broker resolves the provider (API or CLI tunnel).
   */
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
      await this.request({ to: "broker", type: "llm_request", payload }),
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

  /**
   * Request tool execution via the broker.
   * The broker routes to the appropriate tunnel.
   */
  async execTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const payload: ToolRequest = { tool, args };
    const response = await this.request({
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
      await this.request<BrokerTaskSubmitMessage>({
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
      await this.request({ to: "broker", type: "task_continue", payload }),
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

  private async requestTaskResult(
    payload: BrokerTaskQueryPayload,
    type: "task_get" | "task_cancel",
  ): Promise<Task | null> {
    const response = this.unwrapOrThrow(
      await this.request({ to: "broker", type, payload }),
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

  /**
   * Send a message to another agent via the broker.
   */
  async sendToAgent(
    targetAgentId: string,
    instruction: string,
    data?: unknown,
  ): Promise<BrokerEnvelope> {
    const payload: AgentMessagePayload = { instruction, data };
    const response = this.unwrapOrThrow(
      await this.request({
        to: "broker",
        type: "agent_message",
        payload: {
          targetAgent: targetAgentId,
          ...payload,
        },
      }),
    );

    if (response.type !== "agent_response") {
      throw new DenoClawError(
        "BROKER_PROTOCOL_ERROR",
        { expected: "agent_response", actual: response.type },
        "Check broker/client message contract",
      );
    }

    return response;
  }

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

  // ── Lifecycle ───────────────────────────────────────

  close(): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(
        new DenoClawError(
          "BROKER_CLOSED",
          { requestId: id },
          "BrokerClient was closed",
        ),
      );
    }
    this.pendingRequests.clear();
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
    this.listening = false;
  }
}
