import { log } from "../../shared/log.ts";
import type {
  BrokerMessage,
  BrokerTaskContinueMessage,
  BrokerTaskSubmitMessage,
} from "../types.ts";
import type { BrokerAgentRegistry } from "./agent_registry.ts";
import type { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";
import {
  createAgentRouteUnavailableError,
  postBrokerMessageToAgentEndpoint,
} from "./agent_endpoint_delivery.ts";

type BrokerTaskEnvelope = BrokerTaskSubmitMessage | BrokerTaskContinueMessage;

export interface BrokerAgentMessageRouterDeps {
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
      await postBrokerMessageToAgentEndpoint(
        endpoint,
        message,
        this.deps.fetchFn,
      );
      log.info(
        `A2A routed via HTTP wake-up: ${message.from} -> ${targetAgentId} (${message.type})`,
      );
      return;
    }

    throw createAgentRouteUnavailableError(
      message.from,
      targetAgentId,
      message.type,
    );
  }
}
