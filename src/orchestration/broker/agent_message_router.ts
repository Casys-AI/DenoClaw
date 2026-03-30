import { ConfigError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";
import type {
  BrokerMessage,
  BrokerTaskContinueMessage,
  BrokerTaskSubmitMessage,
} from "../types.ts";
import type { BrokerAgentRegistry } from "./agent_registry.ts";
import type { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";

type BrokerTaskEnvelope = BrokerTaskSubmitMessage | BrokerTaskContinueMessage;

export interface BrokerAgentMessageRouterDeps {
  getKv(): Promise<Deno.Kv>;
  metrics: {
    recordAgentMessage(
      fromAgentId: string,
      targetAgentId: string,
    ): Promise<void>;
  };
  connectedAgents: BrokerAgentSocketRegistry;
  agentRegistry: BrokerAgentRegistry;
  tunnelRegistry: TunnelRegistry;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
  fetchFn?: typeof fetch;
}

export class BrokerAgentMessageRouter {
  constructor(private readonly deps: BrokerAgentMessageRouterDeps) {}

  async routeTaskMessage(
    targetAgentId: string,
    message: BrokerTaskEnvelope,
  ): Promise<void> {
    await this.deps.metrics.recordAgentMessage(message.from, targetAgentId);

    const connectedSocket = this.deps.connectedAgents.getSocket(targetAgentId);
    if (connectedSocket) {
      this.deps.routeToTunnel(connectedSocket, message);
      log.info(
        `A2A routed via agent socket: ${message.from} -> ${targetAgentId} (${message.type})`,
      );
      return;
    }

    const tunnel = this.deps.tunnelRegistry.findReplySocket(targetAgentId);
    if (tunnel) {
      this.deps.routeToTunnel(tunnel, message);
      log.info(
        `A2A routed via tunnel: ${message.from} -> ${targetAgentId} (${message.type})`,
      );
      return;
    }

    const endpoint = await this.deps.agentRegistry.getAgentEndpoint(
      targetAgentId,
    );
    if (endpoint) {
      await this.postMessageToAgentEndpoint(endpoint, message);
      log.info(
        `A2A routed via HTTP wake-up: ${message.from} -> ${targetAgentId} (${message.type})`,
      );
      return;
    }

    const kv = await this.deps.getKv();
    await kv.enqueue(message);
    log.info(
      `A2A routed via KV Queue: ${message.from} -> ${targetAgentId} (${message.type})`,
    );
  }

  private async postMessageToAgentEndpoint(
    endpoint: string,
    message: BrokerTaskEnvelope,
  ): Promise<void> {
    const token = Deno.env.get("DENOCLAW_API_TOKEN");
    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn(new URL("/tasks", endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ConfigError(
        "AGENT_ENDPOINT_DELIVERY_FAILED",
        {
          endpoint,
          status: response.status,
          body: body.slice(0, 300),
          targetAgent: message.to,
        },
        "Check agent deployment health and broker registration",
      );
    }
  }
}
