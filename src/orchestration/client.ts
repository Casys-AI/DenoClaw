import type {
  AgentMessagePayload,
  BrokerMessage,
  LLMRequest,
  ToolRequest,
  ToolResponsePayload,
} from "./types.ts";
import type { AgentBrokerPort, LLMResponse, Message, StructuredError, ToolDefinition, ToolResult } from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";

/**
 * BrokerClient — used by agents in Subhosting to communicate with the Broker on Deploy.
 *
 * In local mode: calls providers/tools directly (pass-through).
 * In Subhosting mode: sends requests via KV Queues to the broker.
 */
export class BrokerClient implements AgentBrokerPort {
  private agentId: string;
  private kv: Deno.Kv | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: BrokerMessage) => void;
    reject: (reason: unknown) => void;
  }>();
  private listening = false;

  constructor(agentId: string) {
    this.agentId = agentId;
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
   * Send a message to the broker and wait for a response.
   */
  private async request(to: string, type: BrokerMessage["type"], payload: unknown, timeoutMs = 120_000): Promise<BrokerMessage> {
    const kv = await this.getKv();
    const id = generateId();

    const msg: BrokerMessage = {
      id,
      from: this.agentId,
      to,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    const promise = new Promise<BrokerMessage>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new DenoClawError(
            "BROKER_TIMEOUT",
            { type, to, timeoutMs },
            "Broker did not respond in time. Check broker is running.",
          ));
        }
      }, timeoutMs);
    });

    await kv.enqueue(msg);
    log.debug(`Requête envoyée au broker : ${type} (${id})`);

    return promise;
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
    const payload: LLMRequest = { messages, model, temperature, maxTokens, tools };
    const response = await this.request("broker", "llm_request", payload);

    if (response.type === "error") {
      const err = response.payload as StructuredError;
      throw new DenoClawError(err.code, err.context, err.recovery);
    }

    return response.payload as LLMResponse;
  }

  // ── Tool execution ──────────────────────────────────

  /**
   * Request tool execution via the broker.
   * The broker routes to the appropriate tunnel.
   */
  async execTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const payload: ToolRequest = { tool, args };
    const response = await this.request("broker", "tool_request", payload);

    if (response.type === "error") {
      const err = response.payload as StructuredError;
      return { success: false, output: "", error: { code: err.code, context: err.context, recovery: err.recovery } };
    }

    return response.payload as ToolResponsePayload;
  }

  // ── Inter-agent ─────────────────────────────────────

  /**
   * Send a message to another agent via the broker.
   */
  async sendToAgent(targetAgentId: string, instruction: string, data?: unknown): Promise<BrokerMessage> {
    const payload: AgentMessagePayload = { instruction, data };
    return await this.request("broker", "agent_message", {
      targetAgent: targetAgentId,
      ...payload,
    });
  }

  // ── Lifecycle ───────────────────────────────────────

  close(): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new DenoClawError("BROKER_CLOSED", { requestId: id }, "BrokerClient was closed"));
    }
    this.pendingRequests.clear();
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
    this.listening = false;
  }
}
