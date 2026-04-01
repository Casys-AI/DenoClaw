import type { MetricsCollector } from "../../telemetry/metrics.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import type {
  FederationService,
  KvFederationAdapter,
} from "../federation/mod.ts";
import { log } from "../../shared/log.ts";
import type { AuthManager } from "../auth.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";
import type { BrokerMessage } from "../types.ts";
import type { BrokerAgentRegistry } from "./agent_registry.ts";
import type { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import { handleBrokerAgentSocketUpgrade } from "./agent_socket_upgrade.ts";
import { type BrokerHttpContext, handleBrokerHttp } from "./http_routes.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";
import { handleBrokerTunnelUpgrade } from "./tunnel_upgrade.ts";

export interface BrokerHttpRuntimeDeps {
  tunnelRegistry: TunnelRegistry;
  connectedAgents: BrokerAgentSocketRegistry;
  agentRegistry: BrokerAgentRegistry;
  metrics: MetricsCollector;
  getKv(): Promise<Deno.Kv>;
  getAuth(): Promise<AuthManager>;
  getFederationAdapter(): Promise<KvFederationAdapter>;
  getFederationService(): Promise<FederationService>;
  submitChannelMessage(
    message: ChannelMessage,
    input: {
      routePlan: ChannelRoutePlan;
      taskId: string;
    },
  ): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  continueChannelTask(
    message: ChannelMessage,
    taskId: string,
  ): Promise<Task | null>;
  handleIncomingMessage(msg: BrokerMessage): Promise<void>;
  handleTunnelMessage(tunnelId: string, data: string): Promise<void>;
  markAgentAlive?(agentId: string): Promise<void>;
}

export class BrokerHttpRuntime {
  constructor(private readonly deps: BrokerHttpRuntimeDeps) {}

  async handleHttp(req: Request): Promise<Response> {
    try {
      return await handleBrokerHttp(this.createHttpContext(), req);
    } catch (e) {
      log.error("Unhandled HTTP error", e);
      return Response.json(
        { error: { code: "INTERNAL_ERROR", recovery: "Check broker logs" } },
        { status: 500 },
      );
    }
  }

  async handleAgentSocketUpgrade(req: Request): Promise<Response> {
    return await handleBrokerAgentSocketUpgrade(
      {
        connectedAgents: this.deps.connectedAgents,
        agentRegistry: this.deps.agentRegistry,
        getAuth: () => this.deps.getAuth(),
        handleIncomingMessage: (msg) => this.deps.handleIncomingMessage(msg),
        markAgentAlive: (agentId) => this.deps.markAgentAlive?.(agentId) ??
          Promise.resolve(),
      },
      req,
    );
  }

  async handleTunnelUpgrade(req: Request): Promise<Response> {
    return await handleBrokerTunnelUpgrade(
      {
        tunnelRegistry: this.deps.tunnelRegistry,
        getAuth: () => this.deps.getAuth(),
        getFederationService: () => this.deps.getFederationService(),
        handleTunnelMessage: (tunnelId, data) =>
          this.deps.handleTunnelMessage(tunnelId, data),
      },
      req,
    );
  }

  private createHttpContext(): BrokerHttpContext {
    return {
      tunnelRegistry: this.deps.tunnelRegistry,
      agentRegistry: this.deps.agentRegistry,
      metrics: this.deps.metrics,
      getKv: () => this.deps.getKv(),
      getAuth: () => this.deps.getAuth(),
      submitChannelMessage: (message, input) =>
        this.deps.submitChannelMessage(message, input),
      getTask: (taskId) => this.deps.getTask(taskId),
      continueChannelTask: (message, taskId) =>
        this.deps.continueChannelTask(message, taskId),
      getFederationAdapter: () => this.deps.getFederationAdapter(),
      getFederationService: () => this.deps.getFederationService(),
      handleAgentSocketUpgrade: (req) => this.handleAgentSocketUpgrade(req),
      handleTunnelUpgrade: (req) => this.handleTunnelUpgrade(req),
    };
  }
}
