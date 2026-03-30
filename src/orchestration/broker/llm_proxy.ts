import type { ProviderManager } from "../../llm/manager.ts";
import type { BrokerLLMRequestMessage, BrokerMessage } from "../types.ts";

export interface BrokerLlmProxyDeps {
  providers: Pick<ProviderManager, "complete">;
  metrics: {
    recordLLMCall(
      agentId: string,
      provider: string,
      tokens: { prompt: number; completion: number },
      latencyMs: number,
    ): Promise<void>;
  };
  findTunnelForProvider(model: string): WebSocket | null;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
  sendReply(reply: BrokerMessage): Promise<void>;
}

export class BrokerLlmProxy {
  constructor(private readonly deps: BrokerLlmProxyDeps) {}

  async handleRequest(msg: BrokerLLMRequestMessage): Promise<void> {
    const req = msg.payload;

    const tunnel = this.deps.findTunnelForProvider(req.model);
    if (tunnel) {
      this.deps.routeToTunnel(tunnel, msg);
      return;
    }

    const start = performance.now();
    const response = await this.deps.providers.complete(
      req.messages.map((message) => ({
        role: message.role as "system" | "user" | "assistant" | "tool",
        content: message.content,
        name: message.name,
        tool_call_id: message.tool_call_id,
        tool_calls: message.tool_calls as undefined,
      })),
      req.model,
      req.temperature,
      req.maxTokens,
      req.tools as undefined,
    );
    const latency = performance.now() - start;

    const provider = req.model.split("/")[0] || req.model;
    await this.deps.metrics.recordLLMCall(
      msg.from,
      provider,
      {
        prompt: response.usage?.promptTokens || 0,
        completion: response.usage?.completionTokens || 0,
      },
      latency,
    );

    await this.deps.sendReply({
      id: msg.id,
      from: "broker",
      to: msg.from,
      type: "llm_response",
      payload: response,
      timestamp: new Date().toISOString(),
    });
  }
}
