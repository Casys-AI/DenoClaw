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
import {
  createFederationControlRouter,
  type FederationRoutingPort,
  FederationService,
  KvFederationAdapter,
} from "../federation/mod.ts";
import {
  createBrokerFederationControlHandlers,
  createBrokerFederationRoutingPort,
  handleBrokerFederationControlMessage,
} from "./federation_runtime.ts";
import {
  sendBrokerMessageOverTunnel,
  type TunnelConnection,
  TunnelRegistry,
} from "./tunnel_registry.ts";
import {
  DENOCLAW_AGENT_PROTOCOL,
  isAgentSocketRegisterMessage,
} from "../agent_socket_protocol.ts";
import { BrokerAgentRegistry } from "./agent_registry.ts";
import { type BrokerHttpContext, handleBrokerHttp } from "./http_router.ts";
import { BrokerTaskPersistence } from "./persistence.ts";
import { BrokerReplyDispatcher } from "./reply_dispatch.ts";
import { BrokerTaskDispatcher } from "./task_dispatch.ts";
import { handleBrokerTunnelUpgrade } from "./tunnel_upgrade.ts";
import { BrokerToolDispatcher } from "./tool_dispatch.ts";
import type { ToolExecutionPort } from "../tool_execution_port.ts";
import { LocalToolExecutionAdapter } from "../adapters/tool_execution_local.ts";
import { DenoSandboxBackend } from "../../agent/tools/backends/cloud.ts";
import { TUNNEL_IDLE_TIMEOUT_SECONDS } from "../tunnel_protocol.ts";
import { getSandboxAccessToken } from "../../shared/deploy_credentials.ts";

interface ConnectedAgentSocket {
  ws: WebSocket;
  connectedAt: string;
  authIdentity: string;
}

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
  private connectedAgents = new Map<string, ConnectedAgentSocket>();
  private agentRegistry: BrokerAgentRegistry;
  private taskPersistence: BrokerTaskPersistence;
  private replyDispatcher: BrokerReplyDispatcher;
  private taskDispatcher: BrokerTaskDispatcher;
  private toolDispatcher: BrokerToolDispatcher;
  private federationAdapter: KvFederationAdapter | null = null;
  private federationRoutingPort: FederationRoutingPort | null = null;
  private federationService: FederationService | null = null;
  private federationControlRouter!: ReturnType<
    typeof createFederationControlRouter
  >;
  private httpServer?: Deno.HttpServer;

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
    this.agentRegistry = new BrokerAgentRegistry({
      getKv: () => this.getKv(),
    });
    this.taskPersistence = new BrokerTaskPersistence({
      getKv: () => this.getKv(),
    });
    this.replyDispatcher = new BrokerReplyDispatcher({
      getKv: () => this.getKv(),
      findReplySocket: (agentId) => this.findAgentSocket(agentId),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
    });
    this.taskDispatcher = new BrokerTaskDispatcher({
      taskStore: this.taskStore,
      persistence: this.taskPersistence,
      routeTaskMessage: (targetAgentId, message) =>
        this.routeBrokerMessageToAgent(targetAgentId, message),
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
    this.federationControlRouter = createFederationControlRouter(
      this.getFederationControlHandlers(),
    );
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
    // Warn if no token is configured (ADR-003)
    if (!Deno.env.get("DENOCLAW_API_TOKEN")) {
      log.warn(
        "DENOCLAW_API_TOKEN not set — broker running in unauthenticated mode. Do not use in production.",
      );
    }

    await this.getAuth();

    // HTTP + WebSocket server — all messages arrive via HTTP or WebSocket
    this.httpServer = Deno.serve({ port }, (req) => this.handleHttp(req));

    log.info(`Broker started on port ${port}`);
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
    const req = msg.payload;

    // Check if model is a CLI provider → route to tunnel
    const tunnel = this.findTunnelForProvider(req.model);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      return;
    }

    // Otherwise: direct API call (broker has the keys)
    const start = performance.now();
    const response = await this.providers.complete(
      req.messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant" | "tool",
        content: m.content,
        name: m.name,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls as undefined,
      })),
      req.model,
      req.temperature,
      req.maxTokens,
      req.tools as undefined,
    );
    const latency = performance.now() - start;

    // Record metrics
    const provider = req.model.split("/")[0] || req.model;
    await this.metrics.recordLLMCall(
      msg.from,
      provider,
      {
        prompt: response.usage?.promptTokens || 0,
        completion: response.usage?.completionTokens || 0,
      },
      latency,
    );

    const reply: BrokerMessage = {
      id: msg.id,
      from: "broker",
      to: msg.from,
      type: "llm_response",
      payload: response,
      timestamp: new Date().toISOString(),
    };

    await this.sendReply(reply);
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

  private async routeBrokerMessageToAgent(
    targetAgentId: string,
    message: Extract<
      BrokerMessage,
      {
        type: "task_submit" | "task_continue";
      }
    >,
  ): Promise<void> {
    await this.metrics.recordAgentMessage(message.from, targetAgentId);

    const connectedAgent = this.connectedAgents.get(targetAgentId);
    if (connectedAgent) {
      this.routeToTunnel(connectedAgent.ws, message);
      log.info(
        `A2A routed via agent socket: ${message.from} → ${targetAgentId} (${message.type})`,
      );
      return;
    }

    const tunnel = this.findTunnelByAgentId(targetAgentId);
    if (tunnel) {
      this.routeToTunnel(tunnel, message);
      log.info(
        `A2A routed via tunnel: ${message.from} → ${targetAgentId} (${message.type})`,
      );
      return;
    }

    const endpoint = await this.agentRegistry.getAgentEndpoint(targetAgentId);
    if (endpoint) {
      await this.postMessageToAgentEndpoint(endpoint, message);
      log.info(
        `A2A routed via HTTP wake-up: ${message.from} → ${targetAgentId} (${message.type})`,
      );
      return;
    }

    // Local-mode transport: canonical task messages are delivered over KV Queue
    // when no WebSocket tunnel is active for the target agent.
    const kv = await this.getKv();
    await kv.enqueue(message);
    log.info(
      `A2A routed via KV Queue: ${message.from} → ${targetAgentId} (${message.type})`,
    );
  }

  private async postMessageToAgentEndpoint(
    endpoint: string,
    message: Extract<BrokerMessage, { type: "task_submit" | "task_continue" }>,
  ): Promise<void> {
    const token = Deno.env.get("DENOCLAW_API_TOKEN");
    const res = await fetch(new URL("/tasks", endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConfigError(
        "AGENT_ENDPOINT_DELIVERY_FAILED",
        {
          endpoint,
          status: res.status,
          body: body.slice(0, 300),
          targetAgent: message.to,
        },
        "Check agent deployment health and broker registration",
      );
    }
  }

  // ── Federation control-plane ───────────────────────────

  private async getFederationAdapter(): Promise<KvFederationAdapter> {
    if (this.federationAdapter) return this.federationAdapter;
    this.federationAdapter = new KvFederationAdapter(await this.getKv());
    return this.federationAdapter;
  }

  private async getFederationService(): Promise<FederationService> {
    if (this.federationService) return this.federationService;
    const adapter = await this.getFederationAdapter();
    this.federationService = new FederationService(
      adapter,
      adapter,
      adapter,
      adapter,
      this.createFederationRoutingPort(),
      adapter,
      adapter,
    );
    return this.federationService;
  }

  private createFederationRoutingPort(): FederationRoutingPort {
    if (this.federationRoutingPort) return this.federationRoutingPort;
    this.federationRoutingPort = createBrokerFederationRoutingPort({
      findRemoteBrokerConnection: (remoteBrokerId) =>
        this.findTunnelForRemoteBroker(remoteBrokerId),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      getFederationService: () => this.getFederationService(),
      sendReply: (reply) => this.replyDispatcher.sendReply(reply),
    });
    return this.federationRoutingPort;
  }

  private getFederationControlHandlers() {
    return createBrokerFederationControlHandlers({
      findRemoteBrokerConnection: (remoteBrokerId) =>
        this.findTunnelForRemoteBroker(remoteBrokerId),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      getFederationService: () => this.getFederationService(),
      sendReply: (reply) => this.replyDispatcher.sendReply(reply),
    });
  }

  private async handleFederationControlMessage(
    msg: BrokerFederationMessage,
  ): Promise<void> {
    await handleBrokerFederationControlMessage(
      this.federationControlRouter,
      msg,
    );
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
    try {
      return await this.handleHttpInner(req);
    } catch (e) {
      log.error("Unhandled HTTP error", e);
      return Response.json(
        { error: { code: "INTERNAL_ERROR", recovery: "Check broker logs" } },
        { status: 500 },
      );
    }
  }

  private async handleHttpInner(req: Request): Promise<Response> {
    return await handleBrokerHttp(this.createHttpContext(), req);
  }

  private async handleAgentSocketUpgrade(req: Request): Promise<Response> {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const requestedProtocols = (req.headers.get("sec-websocket-protocol") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!requestedProtocols.includes(DENOCLAW_AGENT_PROTOCOL)) {
      return new Response(
        `Expected WebSocket subprotocol: ${DENOCLAW_AGENT_PROTOCOL}`,
        { status: 426 },
      );
    }

    const auth = await this.getAuth();
    const authResult = await auth.checkRequest(req);
    if (!authResult.ok) {
      return Response.json(
        { error: { code: authResult.code, recovery: authResult.recovery } },
        { status: 401 },
      );
    }

    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: DENOCLAW_AGENT_PROTOCOL,
      idleTimeout: TUNNEL_IDLE_TIMEOUT_SECONDS,
    });

    let registeredAgentId: string | null = null;

    socket.onmessage = (event) => {
      void (async () => {
        try {
          if (typeof event.data !== "string") {
            socket.close(1003, "Agent WebSocket frames must be text JSON");
            return;
          }

          const raw = JSON.parse(event.data);
          if (!registeredAgentId) {
            if (!isAgentSocketRegisterMessage(raw)) {
              socket.close(1002, "Expected register_agent as first message");
              return;
            }

            registeredAgentId = raw.agentId;
            const previous = this.connectedAgents.get(raw.agentId);
            if (previous && previous.ws !== socket) {
              try {
                previous.ws.close(1000, "Replaced by a newer agent socket");
              } catch {
                // ignore close errors
              }
            }

            this.connectedAgents.set(raw.agentId, {
              ws: socket,
              connectedAt: new Date().toISOString(),
              authIdentity: authResult.identity,
            });

            if (raw.config) {
              await this.agentRegistry.saveAgentConfig(raw.agentId, raw.config);
            }
            if (raw.endpoint) {
              await this.agentRegistry.saveAgentEndpoint(
                raw.agentId,
                raw.endpoint,
              );
            }

            socket.send(
              JSON.stringify({
                type: "registered_agent",
                agentId: raw.agentId,
              }),
            );
            log.info(`Agent socket registered: ${raw.agentId}`);
            return;
          }

          const msg = raw as BrokerMessage;
          msg.from = registeredAgentId;
          await this.handleIncomingMessage(msg);
        } catch (error) {
          log.error("Agent socket message handling failed", error);
          socket.close(1002, "Invalid agent socket message");
        }
      })();
    };

    socket.onclose = () => {
      if (registeredAgentId) {
        const current = this.connectedAgents.get(registeredAgentId);
        if (current?.ws === socket) {
          this.connectedAgents.delete(registeredAgentId);
        }
        log.info(`Agent socket disconnected: ${registeredAgentId}`);
      }
    };

    return response;
  }

  private async handleTunnelUpgrade(req: Request): Promise<Response> {
    return await handleBrokerTunnelUpgrade(
      {
        tunnelRegistry: this.tunnelRegistry,
        getAuth: () => this.getAuth(),
        getFederationService: () => this.getFederationService(),
        handleTunnelMessage: (tunnelId, data) =>
          this.handleTunnelMessage(tunnelId, data),
      },
      req,
    );
  }

  private createHttpContext(): BrokerHttpContext {
    return {
      tunnelRegistry: this.tunnelRegistry,
      agentRegistry: this.agentRegistry,
      metrics: this.metrics,
      getKv: () => this.getKv(),
      getAuth: () => this.getAuth(),
      getFederationAdapter: () => this.getFederationAdapter(),
      getFederationService: () => this.getFederationService(),
      handleAgentSocketUpgrade: (req) => this.handleAgentSocketUpgrade(req),
      handleTunnelUpgrade: (req) => this.handleTunnelUpgrade(req),
    };
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
    const connectedAgent = this.connectedAgents.get(agentId);
    if (connectedAgent) return connectedAgent.ws;
    return this.tunnelRegistry.findReplySocket(agentId);
  }

  private findTunnelByAgentId(agentId: string): WebSocket | null {
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
    if (this.httpServer) await this.httpServer.shutdown();
    for (const [agentId, entry] of this.connectedAgents) {
      try {
        entry.ws.close(1001, "Broker shutting down");
      } catch (e) {
        log.warn(`Failed to close agent socket ${agentId} cleanly`, e);
      }
    }
    this.connectedAgents.clear();
    for (const [tunnelId, t] of this.tunnelRegistry.entries()) {
      try {
        t.ws.close(1001, "Broker shutting down");
      } catch (e) {
        log.warn(`Failed to close tunnel ${tunnelId} cleanly`, e);
      }
    }
    this.tunnelRegistry.clear();
    this.taskStore.close();
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
    log.info("Broker stopped");
  }
}
