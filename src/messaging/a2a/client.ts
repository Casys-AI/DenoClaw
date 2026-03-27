import type { A2AMessage, AgentCard, JsonRpcRequest, JsonRpcResponse, Task } from "./types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

/**
 * A2A Client — call a remote A2A agent.
 * Discovers via /.well-known/agent-card.json, sends Tasks via JSON-RPC 2.0.
 */
export class A2AClient {
  private cardCache = new Map<string, AgentCard>();

  /**
   * Discover a remote agent's capabilities.
   */
  async discover(agentUrl: string): Promise<AgentCard> {
    const cached = this.cardCache.get(agentUrl);
    if (cached) return cached;

    const cardUrl = new URL("/.well-known/agent-card.json", agentUrl).toString();
    log.debug(`A2A discover: ${cardUrl}`);

    const res = await fetch(cardUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new DenoClawError(
        "A2A_DISCOVERY_FAILED",
        { url: cardUrl, status: res.status },
        "Check agent URL and ensure it exposes /.well-known/agent-card.json",
      );
    }

    const card = await res.json() as AgentCard;
    this.cardCache.set(agentUrl, card);
    return card;
  }

  /**
   * Send a message to a remote A2A agent (sync).
   */
  async send(
    agentUrl: string,
    message: A2AMessage,
    taskId?: string,
    authToken?: string,
  ): Promise<Task> {
    const card = await this.discover(agentUrl);

    const rpc: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message,
        ...(taskId ? { taskId } : {}),
      },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    log.debug(`A2A send: ${card.url}`);

    const res = await fetch(card.url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new DenoClawError(
        "A2A_SEND_FAILED",
        { url: card.url, status: res.status, body: text.slice(0, 500) },
        "Check agent availability and auth token",
      );
    }

    const response = await res.json() as JsonRpcResponse;

    if (response.error) {
      throw new DenoClawError(
        "A2A_RPC_ERROR",
        { code: response.error.code, message: response.error.message },
        "Check task parameters",
      );
    }

    return response.result as Task;
  }

  /**
   * Send a message and stream the response via SSE.
   */
  async *stream(
    agentUrl: string,
    message: A2AMessage,
    taskId?: string,
    authToken?: string,
  ): AsyncGenerator<JsonRpcResponse> {
    const card = await this.discover(agentUrl);

    const rpc: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/stream",
      params: {
        message,
        ...(taskId ? { taskId } : {}),
      },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    const res = await fetch(card.url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok || !res.body) {
      throw new DenoClawError(
        "A2A_STREAM_FAILED",
        { url: card.url, status: res.status },
        "Check agent availability",
      );
    }

    // Parse SSE stream
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data) {
            yield JSON.parse(data) as JsonRpcResponse;
          }
        }
      }
    }
  }

  /**
   * Get task status.
   */
  async getTask(agentUrl: string, taskId: string, authToken?: string): Promise<Task> {
    const card = await this.discover(agentUrl);

    const rpc: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/get",
      params: { taskId },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    const res = await fetch(card.url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
    });

    const response = await res.json() as JsonRpcResponse;
    if (response.error) {
      throw new DenoClawError("A2A_RPC_ERROR", { code: response.error.code }, response.error.message);
    }
    return response.result as Task;
  }

  /**
   * Cancel a running task.
   */
  async cancelTask(agentUrl: string, taskId: string, authToken?: string): Promise<Task> {
    const card = await this.discover(agentUrl);

    const rpc: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/cancel",
      params: { taskId },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    const res = await fetch(card.url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
    });

    const response = await res.json() as JsonRpcResponse;
    if (response.error) {
      throw new DenoClawError("A2A_RPC_ERROR", { code: response.error.code }, response.error.message);
    }
    return response.result as Task;
  }
}
