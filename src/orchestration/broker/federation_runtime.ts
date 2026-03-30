import { DenoClawError } from "../../shared/errors.ts";
import type { BrokerFederationMessage, BrokerMessage } from "../types.ts";
import type {
  FederationControlEnvelope,
  FederationRoutingPort,
} from "../federation/mod.ts";
import {
  createFederationControlRouter,
  FederationService,
  isFederationControlMethod,
  KvFederationAdapter,
} from "../federation/mod.ts";
import {
  createBrokerFederationRoutingPort,
} from "./federation_routing_port.ts";
import { createBrokerFederationControlHandlers } from "./federation_control_handlers.ts";
import type { TunnelConnection } from "./tunnel_registry.ts";

export interface BrokerFederationRuntimeDeps {
  getKv(): Promise<Deno.Kv>;
  findRemoteBrokerConnection(remoteBrokerId: string): TunnelConnection | null;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
  sendReply(reply: BrokerMessage): Promise<void>;
}

export class BrokerFederationRuntime {
  private adapter: KvFederationAdapter | null = null;
  private routingPort: FederationRoutingPort | null = null;
  private service: FederationService | null = null;
  private controlRouter:
    | ReturnType<typeof createFederationControlRouter>
    | null = null;

  constructor(private readonly deps: BrokerFederationRuntimeDeps) {}

  async getAdapter(): Promise<KvFederationAdapter> {
    if (this.adapter) return this.adapter;
    this.adapter = new KvFederationAdapter(await this.deps.getKv());
    return this.adapter;
  }

  async getService(): Promise<FederationService> {
    if (this.service) return this.service;
    const adapter = await this.getAdapter();
    this.service = new FederationService(
      adapter,
      adapter,
      adapter,
      adapter,
      this.getRoutingPort(),
      adapter,
      adapter,
    );
    return this.service;
  }

  async handleControlMessage(msg: BrokerFederationMessage): Promise<void> {
    await handleBrokerFederationControlMessage(this.getControlRouter(), msg);
  }

  private getRoutingPort(): FederationRoutingPort {
    if (this.routingPort) return this.routingPort;
    this.routingPort = createBrokerFederationRoutingPort({
      findRemoteBrokerConnection: (remoteBrokerId) =>
        this.deps.findRemoteBrokerConnection(remoteBrokerId),
      routeToTunnel: (ws, msg) => this.deps.routeToTunnel(ws, msg),
      getFederationService: () => this.getService(),
      sendReply: (reply) => this.deps.sendReply(reply),
    });
    return this.routingPort;
  }

  private getControlRouter(): ReturnType<typeof createFederationControlRouter> {
    if (this.controlRouter) return this.controlRouter;
    this.controlRouter = createFederationControlRouter(
      createBrokerFederationControlHandlers({
        findRemoteBrokerConnection: (remoteBrokerId) =>
          this.deps.findRemoteBrokerConnection(remoteBrokerId),
        routeToTunnel: (ws, msg) => this.deps.routeToTunnel(ws, msg),
        getFederationService: () => this.getService(),
        sendReply: (reply) => this.deps.sendReply(reply),
      }),
    );
    return this.controlRouter;
  }
}

export { createBrokerFederationControlHandlers } from "./federation_control_handlers.ts";
export { createBrokerFederationRoutingPort } from "./federation_routing_port.ts";
export type { BrokerFederationMessagingDeps } from "./federation_routing_port.ts";

export async function handleBrokerFederationControlMessage(
  router: (envelope: FederationControlEnvelope) => Promise<void>,
  msg: BrokerFederationMessage,
): Promise<void> {
  if (!isFederationControlMethod(msg.type)) {
    throw new DenoClawError(
      "FEDERATION_METHOD_INVALID",
      { type: msg.type },
      "Use federation control-plane method names",
    );
  }
  await router({
    id: msg.id,
    from: msg.from,
    type: msg.type,
    payload: msg.payload,
    timestamp: msg.timestamp,
  });
}
