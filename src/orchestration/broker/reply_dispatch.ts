import type { Task } from "../../messaging/a2a/types.ts";
import { log } from "../../shared/log.ts";
import type { StructuredError } from "../../shared/types.ts";
import type { BrokerMessage } from "../types.ts";
import type { BrokerAgentRegistry } from "./agent_registry.ts";
import {
  createAgentRouteUnavailableError,
  postBrokerMessageToAgentEndpoint,
} from "./agent_endpoint_delivery.ts";

export interface BrokerReplyDispatcherDeps {
  findReplySocket(agentId: string): WebSocket | null;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
  agentRegistry: BrokerAgentRegistry;
  fetchFn?: typeof fetch;
}

export class BrokerReplyDispatcher {
  constructor(private readonly deps: BrokerReplyDispatcherDeps) {}

  async sendReply(reply: BrokerMessage): Promise<void> {
    const tunnel = this.deps.findReplySocket(reply.to);
    if (tunnel) {
      this.deps.routeToTunnel(tunnel, reply);
      return;
    }

    const endpoint = await this.deps.agentRegistry.getAgentEndpoint(reply.to);
    if (endpoint) {
      await postBrokerMessageToAgentEndpoint(
        endpoint,
        reply,
        this.deps.fetchFn,
      );
      log.info(
        `Reponse routee via HTTP wake-up : broker -> ${reply.to} (${reply.type})`,
      );
      return;
    }

    throw createAgentRouteUnavailableError("broker", reply.to, reply.type);
  }

  async sendTaskResult(
    to: string,
    requestId: string,
    task: Task | null,
  ): Promise<void> {
    await this.sendReply({
      id: requestId,
      from: "broker",
      to,
      type: "task_result",
      payload: { task },
      timestamp: new Date().toISOString(),
    });
  }

  async sendStructuredError(
    to: string,
    requestId: string,
    error: StructuredError,
  ): Promise<void> {
    await this.sendReply({
      id: requestId,
      from: "broker",
      to,
      type: "error",
      payload: error,
      timestamp: new Date().toISOString(),
    });
  }
}
