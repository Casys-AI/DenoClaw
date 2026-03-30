import type {
  BrokerFederationMessage,
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskResultPayload,
  BrokerTaskSubmitPayload,
} from "../types.ts";
import type { StructuredError, ToolResult } from "../../shared/types.ts";
import type { ExecPolicy } from "../../agent/sandbox_types.ts";
import type { Config } from "../../config/types.ts";
import { AuthManager } from "../auth.ts";
import { ProviderManager } from "../../llm/manager.ts";
import { MetricsCollector } from "../../telemetry/metrics.ts";
import { ConfigError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";
import { TaskStore } from "../../messaging/a2a/tasks.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import type {
  FederationService,
  KvFederationAdapter,
} from "../federation/mod.ts";
import { BrokerFederationRuntime } from "./federation_runtime.ts";
import {
  sendBrokerMessageOverTunnel,
  type TunnelConnection,
  TunnelRegistry,
} from "./tunnel_registry.ts";
import { BrokerAgentRegistry } from "./agent_registry.ts";
import { BrokerAgentMessageRouter } from "./agent_message_router.ts";
import { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import { BrokerLifecycleRuntime } from "./lifecycle_runtime.ts";
import { BrokerLlmProxy } from "./llm_proxy.ts";
import { BrokerHttpRuntime } from "./http_runtime.ts";
import { BrokerTaskPersistence } from "./persistence.ts";
import { BrokerReplyDispatcher } from "./reply_dispatch.ts";
import { BrokerTaskDispatcher } from "./task_dispatch.ts";
import { BrokerToolDispatcher } from "./tool_dispatch.ts";
import type { ToolExecutionPort } from "../tool_execution_port.ts";
import { LocalToolExecutionAdapter } from "../adapters/tool_execution_local.ts";
import { DenoSandboxBackend } from "../../agent/tools/backends/cloud.ts";
import { getSandboxAccessToken } from "../../shared/deploy_credentials.ts";

/**
 * Broker server — runs on Deno Deploy.
 *
 * Responsibilities:
 * - LLM Proxy (API keys + CLI tunnel routing)
 * - Canonical A2A task routing between agents
 * - Tunnel hub (WebSocket connections to local machines)
 * - Agent lifecycle (Subhosting + Sandbox CRUD)
 *
 * Transport: KV Queue locally, HTTP/SSE on the network.
 * KV Queue is the current local transport — not the canonical model.
 */
export interface BrokerServerDeps {
  providers?: ProviderManager;
  toolExecution?: ToolExecutionPort;
  metrics?: MetricsCollector;
  kv?: Deno.Kv;
  taskStore?: TaskStore;
  tunnelRegistry?: TunnelRegistry;
}

export class BrokerServer {
  private config: Config;
  private auth!: AuthManager;
  private providers: ProviderManager;
  private toolExecution: ToolExecutionPort;
  private metrics: MetricsCollector;
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private taskStore: TaskStore;
  private tunnelRegistry: TunnelRegistry;
  private connectedAgents: BrokerAgentSocketRegistry;
  private agentRegistry: BrokerAgentRegistry;
  private agentMessageRouter: BrokerAgentMessageRouter;
  private llmProxy: BrokerLlmProxy;
  private taskPersistence: BrokerTaskPersistence;
  private replyDispatcher: BrokerReplyDispatcher;
  private taskDispatcher: BrokerTaskDispatcher;
  private toolDispatcher: BrokerToolDispatcher;
  private federationRuntime: BrokerFederationRuntime;
  private httpRuntime: BrokerHttpRuntime;
  private lifecycleRuntime: BrokerLifecycleRuntime;

  constructor(config: Config, deps?: BrokerServerDeps) {
    this.config = config;
    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.toolExecution = deps?.toolExecution ??
      this.createDefaultToolExecutionAdapter();
    this.metrics = deps?.metrics ?? new MetricsCollector();
    this.kv = deps?.kv ?? null;
    this.ownsKv = !deps?.kv;
    this.taskStore = deps?.taskStore ?? new TaskStore(deps?.kv);
    this.tunnelRegistry = deps?.tunnelRegistry ?? new TunnelRegistry();
    this.connectedAgents = new BrokerAgentSocketRegistry();
    this.agentRegistry = new BrokerAgentRegistry({
      getKv: () => this.getKv(),
    });
    this.agentMessageRouter = new BrokerAgentMessageRouter({
      getKv: () => this.getKv(),
      metrics: this.metrics,
      connectedAgents: this.connectedAgents,
      agentRegistry: this.agentRegistry,
      tunnelRegistry: this.tunnelRegistry,
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
    });
    this.taskPersistence = new BrokerTaskPersistence({
      getKv: () => this.getKv(),
    });
    this.replyDispatcher = new BrokerReplyDispatcher({
      getKv: () => this.getKv(),
      findReplySocket: (agentId) => this.findAgentSocket(agentId),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
    });
    this.federationRuntime = new BrokerFederationRuntime({
      getKv: () => this.getKv(),
      findRemoteBrokerConnection: (remoteBrokerId) =>
        this.findTunnelForRemoteBroker(remoteBrokerId),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      sendReply: (reply) => this.replyDispatcher.sendReply(reply),
    });
    this.httpRuntime = new BrokerHttpRuntime({
      tunnelRegistry: this.tunnelRegistry,
      connectedAgents: this.connectedAgents,
      agentRegistry: this.agentRegistry,
      metrics: this.metrics,
      getKv: () => this.getKv(),
      getAuth: () => this.getAuth(),
      getFederationAdapter: () => this.getFederationAdapter(),
      getFederationService: () => this.getFederationService(),
      handleIncomingMessage: (msg) => this.handleIncomingMessage(msg),
      handleTunnelMessage: (tunnelId, data) =>
        this.handleTunnelMessage(tunnelId, data),
    });
    this.lifecycleRuntime = new BrokerLifecycleRuntime({
      connectedAgents: this.connectedAgents,
      tunnelRegistry: this.tunnelRegistry,
      taskStore: this.taskStore,
      getAuth: () => this.getAuth(),
      handleHttp: (req) => this.handleHttp(req),
      closeOwnedKv: () => {
        if (this.kv && this.ownsKv) {
          this.kv.close();
          this.kv = null;
        }
      },
    });
    this.taskDispatcher = new BrokerTaskDispatcher({
      taskStore: this.taskStore,
      persistence: this.taskPersistence,
      routeTaskMessage: (targetAgentId, message) =>
        this.agentMessageRouter.routeTaskMessage(targetAgentId, message),
    });
    this.toolDispatcher = new BrokerToolDispatcher({
      config: this.config,
      getKv: () => this.getKv(),
      toolExecution: this.toolExecution,
      tunnelRegistry: this.tunnelRegistry,
      replyDispatcher: this.replyDispatcher,
      persistence: this.taskPersistence,
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      metrics: this.metrics,
    });
    this.llmProxy = new BrokerLlmProxy({
      providers: this.providers,
      metrics: this.metrics,
      findTunnelForProvider: (model) => this.findTunnelForProvider(model),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      sendReply: (reply) => this.sendReply(reply),
    });
  }

  private createDefaultToolExecutionAdapter(): ToolExecutionPort {
    const sandboxToken = getSandboxAccessToken() ?? "";
    const defaultSandboxConfig = this.config.agents?.defaults?.sandbox ?? {
      allowedPermissions: [],
    };
    const sandbox = sandboxToken
      ? new DenoSandboxBackend(defaultSandboxConfig, sandboxToken)
      : null;
    return new LocalToolExecutionAdapter({
      sandbox,
      requireSandboxForPermissionedTools: true,
    });
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      try {
        this.kv = await Deno.openKv();
      } catch (e) {
        throw new ConfigError(
          "KV_UNAVAILABLE",
          { cause: (e instanceof Error ? e : new Error(String(e))).message },
          "Check Deno Deploy KV permissions or quota",
        );
      }
    }
    return this.kv;
  }

  private async getAuth(): Promise<AuthManager> {
    if (!this.auth) {
      this.auth = new AuthManager(await this.getKv());
      const oidcAudience = Deno.env.get("DENOCLAW_BROKER_OIDC_AUDIENCE") ||
        this.config.deploy?.oidcAudience ||
        Deno.env.get("DENOCLAW_BROKER_URL") ||
        this.config.deploy?.url;
      if (oidcAudience) {
        this.auth.setOIDCAudience(oidcAudience);
      }
    }
    return this.auth;
  }

  async start(port = 3000): Promise<void> {
    await this.lifecycleRuntime.start(port);
  }

  /**
   * Handle an incoming broker message (public entry point).
   * Called from HTTP handler, WebSocket tunnel, or local KV Queue.
   */
  async handleIncomingMessage(msg: BrokerMessage): Promise<void> {
    if (msg.to !== "broker") return;
    await this.handleMessage(msg);
  }

  private async handleMessage(msg: BrokerMessage): Promise<void> {
    log.info(`Broker: ${msg.type} from ${msg.from}`);

    try {
      switch (msg.type) {
        case "llm_request":
          await this.handleLLMRequest(msg);
          break;
        case "tool_request":
          await this.handleToolRequest(msg);
          break;
        case "task_submit":
          await this.handleTaskSubmit(msg);
          break;
        case "task_get":
          await this.handleTaskGet(msg);
          break;
        case "task_continue":
          await this.handleTaskContinue(msg);
          break;
        case "task_cancel":
          await this.handleTaskCancel(msg);
          break;
        case "task_result":
          await this.handleTaskResult(msg);
          break;
        case "federation_link_open":
        case "federation_link_ack":
        case "federation_catalog_sync":
        case "federation_route_probe":
        case "federation_link_close":
          await this.handleFederationControlMessage(msg);
          break;
        default:
          log.warn(`Unknown message type: ${msg.type}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.error(`Message handler failed for ${msg.type} from ${msg.from}`, err);
      try {
        await this.sendStructuredError(msg.from, msg.id, {
          code: "BROKER_ERROR",
          context: {
            messageType: msg.type,
            from: msg.from,
            cause: err.message,
          },
          recovery: "Check broker logs for details",
        });
      } catch (sendErr) {
        log.error(
          "Failed to send error reply to agent (KV unavailable?)",
          sendErr,
        );
      }
    }
  }

  // ── LLM Proxy ───────────────────────────────────────

  private async handleLLMRequest(
    msg: Extract<BrokerMessage, { type: "llm_request" }>,
  ): Promise<void> {
    await this.llmProxy.handleRequest(msg);
  }

  // ── Tool routing (ADR-005: permissions par intersection) ─

  private async handleToolRequest(
    msg: Extract<BrokerMessage, { type: "tool_request" }>,
  ): Promise<void> {
    await this.toolDispatcher.handleToolRequest(msg);
  }

  async resolveBrokerToolApprovalRequirement(
    agentId: string,
    req: { tool: string; args: Record<string, unknown>; taskId?: string },
    agentPolicy?: ExecPolicy,
    defaultPolicy?: ExecPolicy,
  ): Promise<ToolResult | null> {
    return await this.toolDispatcher.resolveBrokerToolApprovalRequirement(
      agentId,
      req,
      agentPolicy,
      defaultPolicy,
    );
  }

  // ── Canonical task message handlers ─────────────────

  private async handleTaskSubmit(
    msg: Extract<BrokerMessage, { type: "task_submit" }>,
  ): Promise<void> {
    await this.replyDispatcher.sendTaskResult(
      msg.from,
      msg.id,
      await this.submitAgentTask(msg.from, msg.payload),
    );
  }

  private async handleTaskGet(
    msg: Extract<BrokerMessage, { type: "task_get" }>,
  ): Promise<void> {
    await this.replyDispatcher.sendTaskResult(
      msg.from,
      msg.id,
      await this.getTask(msg.payload),
    );
  }

  private async handleTaskContinue(
    msg: Extract<BrokerMessage, { type: "task_continue" }>,
  ): Promise<void> {
    await this.replyDispatcher.sendTaskResult(
      msg.from,
      msg.id,
      await this.continueAgentTask(msg.from, msg.payload),
    );
  }

  private async handleTaskCancel(
    msg: Extract<BrokerMessage, { type: "task_cancel" }>,
  ): Promise<void> {
    await this.replyDispatcher.sendTaskResult(
      msg.from,
      msg.id,
      await this.cancelTask(msg.payload),
    );
  }

  private async handleTaskResult(
    msg: Extract<BrokerMessage, { type: "task_result" }>,
  ): Promise<void> {
    await this.replyDispatcher.sendTaskResult(
      msg.from,
      msg.id,
      await this.recordTaskResult(msg.from, msg.payload),
    );
  }

  async submitAgentTask(
    fromAgentId: string,
    payload: BrokerTaskSubmitPayload,
  ): Promise<Task> {
    return await this.taskDispatcher.submitAgentTask(fromAgentId, payload);
  }

  async getTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.taskDispatcher.getTask(payload);
  }

  async continueAgentTask(
    fromAgentId: string,
    payload: BrokerTaskContinuePayload,
  ): Promise<Task | null> {
    return await this.taskDispatcher.continueAgentTask(fromAgentId, payload);
  }

  async cancelTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.taskDispatcher.cancelTask(payload);
  }

  async recordTaskResult(
    fromAgentId: string,
    payload: BrokerTaskResultPayload,
  ): Promise<Task | null> {
    return await this.taskDispatcher.recordTaskResult(fromAgentId, payload);
  }

  // ── Federation control-plane ───────────────────────────

  private async getFederationAdapter(): Promise<KvFederationAdapter> {
    return await this.federationRuntime.getAdapter();
  }

  private async getFederationService(): Promise<FederationService> {
    return await this.federationRuntime.getService();
  }

  private async handleFederationControlMessage(
    msg: BrokerFederationMessage,
  ): Promise<void> {
    await this.federationRuntime.handleControlMessage(msg);
  }

  // ── Tunnel management ───────────────────────────────

  private findTunnelForProvider(_model: string): WebSocket | null {
    // CLI providers now run on the agent's VPS, not via tunnel.
    // Tunnels are for tools and instance-to-instance routing.
    return null;
  }

  private findTunnelForRemoteBroker(
    remoteBrokerId: string,
  ): TunnelConnection | null {
    return this.tunnelRegistry.findRemoteBrokerConnection(remoteBrokerId);
  }

  private routeToTunnel(ws: WebSocket, msg: BrokerMessage): void {
    sendBrokerMessageOverTunnel(ws, msg);
  }

  private async handleTunnelMessage(
    tunnelId: string,
    data: string,
  ): Promise<void> {
    let msg: BrokerMessage;
    try {
      msg = JSON.parse(data) as BrokerMessage;
    } catch {
      log.error(`Malformed JSON from tunnel ${tunnelId}, message dropped`, {
        preview: data.slice(0, 200),
      });
      return;
    }
    try {
      await this.handleMessage(msg);
    } catch (e) {
      log.error(`Failed to handle tunnel message from ${tunnelId}`, e);
    }
  }

  // ── HTTP + WebSocket (ADR-003: auth built in) ───────

  private async handleHttp(req: Request): Promise<Response> {
    return await this.httpRuntime.handleHttp(req);
  }

  async handleHttpInner(req: Request): Promise<Response> {
    return await this.httpRuntime.handleHttp(req);
  }

  async handleAgentSocketUpgrade(req: Request): Promise<Response> {
    return await this.httpRuntime.handleAgentSocketUpgrade(req);
  }

  async handleTunnelUpgrade(req: Request): Promise<Response> {
    return await this.httpRuntime.handleTunnelUpgrade(req);
  }

  // ── Helpers ─────────────────────────────────────────

  /**
   * Send a broker reply to an agent.
   * Prefer an active WebSocket tunnel; otherwise fall back to the local KV Queue transport.
   */
  private async sendReply(reply: BrokerMessage): Promise<void> {
    await this.replyDispatcher.sendReply(reply);
  }

  private findAgentSocket(agentId: string): WebSocket | null {
    const connectedAgentSocket = this.connectedAgents.getSocket(agentId);
    if (connectedAgentSocket) return connectedAgentSocket;
    return this.tunnelRegistry.findReplySocket(agentId);
  }

  private async sendStructuredError(
    to: string,
    requestId: string,
    error: StructuredError,
  ): Promise<void> {
    await this.replyDispatcher.sendStructuredError(to, requestId, error);
  }

  async stop(): Promise<void> {
    await this.lifecycleRuntime.stop();
  }
}
