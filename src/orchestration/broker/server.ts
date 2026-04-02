import type {
  BrokerMessage,
  BrokerTaskContinuePayload,
  BrokerTaskQueryPayload,
  BrokerTaskResultPayload,
  BrokerTaskSubmitPayload,
} from "../types.ts";
import { parseBrokerMessage } from "../types.ts";
import type { StructuredError, ToolResult } from "../../shared/types.ts";
import type { AgentStatusValue } from "../monitoring_types.ts";
import type { ExecPolicy } from "../../shared/types.ts";
import type { Config } from "../../config/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
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
import {
  getMaxSandboxesPerBroker,
  getSandboxAccessToken,
} from "../../shared/deploy_credentials.ts";
import { BrokerMessageRuntime } from "./message_runtime.ts";
import { BrokerSandboxManager } from "./sandbox_manager.ts";
import type { BrokerCronManager } from "./cron_manager.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";
import { ensureAgentListed } from "../monitoring.ts";
import {
  recordTaskResult as recordAnalyticsTaskResult,
  recordTaskSubmission as recordAnalyticsTaskSubmission,
} from "./analytics_hooks.ts";

/**
 * Broker server — runs on Deno Deploy.
 *
 * Responsibilities:
 * - LLM Proxy (API keys + CLI tunnel routing)
 * - Canonical A2A task routing between agents
 * - Tunnel hub (WebSocket connections to local machines)
 * - Agent lifecycle (Subhosting + Sandbox CRUD)
 *
 * Transport: active sockets/tunnels first, HTTP wake-up second.
 * The broker does not fall back to KV Queue for broker↔agent routing.
 */
export interface BrokerServerDeps {
  providers?: ProviderManager;
  toolExecution?: ToolExecutionPort;
  metrics?: MetricsCollector;
  kv?: Deno.Kv;
  taskStore?: TaskStore;
  tunnelRegistry?: TunnelRegistry;
  cronManager?: BrokerCronManager;
  fetchFn?: typeof fetch;
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
  private cronManager: BrokerCronManager | null;
  private federationRuntime: BrokerFederationRuntime;
  private httpRuntime: BrokerHttpRuntime;
  private lifecycleRuntime: BrokerLifecycleRuntime;
  private messageRuntime: BrokerMessageRuntime;

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
    this.cronManager = deps?.cronManager ?? null;
    this.connectedAgents = new BrokerAgentSocketRegistry();
    this.agentRegistry = new BrokerAgentRegistry({
      getKv: () => this.getKv(),
    });
    this.agentMessageRouter = new BrokerAgentMessageRouter({
      metrics: this.metrics,
      connectedAgents: this.connectedAgents,
      agentRegistry: this.agentRegistry,
      tunnelRegistry: this.tunnelRegistry,
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      fetchFn: deps?.fetchFn,
    });
    this.taskPersistence = new BrokerTaskPersistence({
      getKv: () => this.getKv(),
    });
    this.replyDispatcher = new BrokerReplyDispatcher({
      findReplySocket: (agentId) => this.findReplySocket(agentId),
      routeToTunnel: (ws, msg) => this.routeToTunnel(ws, msg),
      agentRegistry: this.agentRegistry,
      fetchFn: deps?.fetchFn,
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
      submitChannelMessage: (message, input) =>
        this.submitChannelMessage(message, input),
      getTask: (taskId) => this.getTask({ taskId }),
      continueChannelTask: (message, taskId) =>
        this.continueChannelTask(message, {
          taskId,
          continuationMessage: {
            messageId: message.id,
            role: "user",
            parts: [{ kind: "text", text: message.content }],
            metadata: {
              channel: {
                channelType: message.channelType,
                sessionId: message.sessionId,
                userId: message.userId,
                address: message.address,
                timestamp: message.timestamp,
              },
              ...(message.metadata ? { channelMessage: message.metadata } : {}),
            },
          },
          metadata: message.metadata,
        }),
      handleIncomingMessage: (msg) => this.handleIncomingMessage(msg),
      handleTunnelMessage: (tunnelId, data) =>
        this.handleTunnelMessage(tunnelId, data),
      markAgentAlive: (agentId) => this.markAgentAlive(agentId),
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
      config: this.config,
      taskStore: this.taskStore,
      persistence: this.taskPersistence,
      getAgentConfigEntry: (agentId) =>
        this.agentRegistry.getAgentConfigEntry(agentId),
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
      cronManager: deps?.cronManager,
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
    this.messageRuntime = new BrokerMessageRuntime({
      llmProxy: this.llmProxy,
      toolDispatcher: this.toolDispatcher,
      replyDispatcher: this.replyDispatcher,
      taskDispatcher: this.taskDispatcher,
      federationRuntime: this.federationRuntime,
      sendStructuredError: (to, requestId, error) =>
        this.sendStructuredError(to, requestId, error),
      writeAgentLiveness: (agentId: string) => this.markAgentAlive(agentId),
    });
  }

  private createDefaultToolExecutionAdapter(): ToolExecutionPort {
    const sandboxToken = getSandboxAccessToken() ?? "";
    const sandbox = sandboxToken
      ? new BrokerSandboxManager({
        maxSandboxes: getMaxSandboxesPerBroker(),
        createBackend: (sandboxConfig, _context, labels) =>
          new DenoSandboxBackend(sandboxConfig, sandboxToken, {
            trustGrantedPermissions: true,
            labels,
          }),
      })
      : null;
    return new LocalToolExecutionAdapter({
      sandbox,
      requireSandboxForPermissionedTools: true,
      getWorkspaceKv: () => this.getKv(),
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

  private async markAgentAlive(agentId: string): Promise<void> {
    const kv = await this.getKv();
    const now = new Date().toISOString();
    const current = await kv.get<AgentStatusValue>([
      "agents",
      agentId,
      "status",
    ]);
    await kv.set(
      ["agents", agentId, "status"],
      {
        ...(current.value ?? {}),
        status: "alive",
        startedAt: current.value?.startedAt ?? now,
        lastHeartbeat: now,
      } satisfies AgentStatusValue,
    );
    await ensureAgentListed(kv, agentId);
  }

  async start(port = 3000): Promise<void> {
    if (this.cronManager) {
      this.cronManager.setOnFire(async (job) => {
        await this.taskDispatcher.submitInternalTask(
          job.agentId,
          {
            messageId: crypto.randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: job.prompt }],
          },
          {
            cronJobId: job.id,
            cronName: job.name,
            cronSchedule: job.schedule,
          },
        );
      });
      await this.cronManager.reloadAll();
    }
    await this.lifecycleRuntime.start(port);
  }

  /**
   * Handle an incoming broker message (public entry point).
   * Called from HTTP handler, WebSocket tunnel, or local KV Queue.
   */
  async handleIncomingMessage(msg: BrokerMessage): Promise<void> {
    await this.messageRuntime.handleIncomingMessage(msg);
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

  async handleToolRequest(
    msg: Extract<BrokerMessage, { type: "tool_request" }>,
  ): Promise<void> {
    await this.toolDispatcher.handleToolRequest(msg);
  }

  async submitAgentTask(
    fromAgentId: string,
    payload: BrokerTaskSubmitPayload,
  ): Promise<Task> {
    const task = await this.taskDispatcher.submitAgentTask(fromAgentId, payload);
    recordAnalyticsTaskSubmission({
      taskId: task.id,
      contextId: task.contextId,
      fromAgent: fromAgentId,
      targetAgent: payload.targetAgent,
      submittedAt: new Date(task.status.timestamp),
    });
    return task;
  }

  async submitChannelMessage(
    message: ChannelMessage,
    input: {
      routePlan: ChannelRoutePlan;
      taskId: string;
    },
  ): Promise<Task> {
    const task = await this.taskDispatcher.submitChannelTask(message, input);
    const brokerMetadata = this.taskPersistence.getTaskBrokerMetadata(task);
    if (brokerMetadata.submittedBy && brokerMetadata.targetAgent) {
      recordAnalyticsTaskSubmission({
        taskId: task.id,
        contextId: task.contextId,
        fromAgent: brokerMetadata.submittedBy,
        targetAgent: brokerMetadata.targetAgent,
        submittedAt: new Date(task.status.timestamp),
      });
    }
    return task;
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

  async continueChannelTask(
    message: ChannelMessage,
    payload: BrokerTaskContinuePayload,
  ): Promise<Task | null> {
    return await this.taskDispatcher.continueChannelTask(message, payload);
  }

  async cancelTask(payload: BrokerTaskQueryPayload): Promise<Task | null> {
    return await this.taskDispatcher.cancelTask(payload);
  }

  async recordTaskResult(
    fromAgentId: string,
    payload: BrokerTaskResultPayload,
  ): Promise<Task | null> {
    const task = await this.taskDispatcher.recordTaskResult(fromAgentId, payload);
    if (task) {
      const brokerMetadata = this.taskPersistence.getTaskBrokerMetadata(task);
      recordAnalyticsTaskResult({
        taskId: task.id,
        contextId: task.contextId,
        fromAgent: brokerMetadata.submittedBy ?? "broker",
        targetAgent: brokerMetadata.targetAgent ?? fromAgentId,
        state: task.status.state,
        changedAt: new Date(task.status.timestamp),
      });
    }
    return task;
  }

  // ── Federation control-plane ───────────────────────────

  private async getFederationAdapter(): Promise<KvFederationAdapter> {
    return await this.federationRuntime.getAdapter();
  }

  private async getFederationService(): Promise<FederationService> {
    return await this.federationRuntime.getService();
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
    try {
      const msg = parseBrokerMessage(JSON.parse(data));
      try {
        await this.messageRuntime.handleMessage(msg);
      } catch (e) {
        log.error(`Failed to handle tunnel message from ${tunnelId}`, e);
      }
    } catch {
      log.error(`Malformed JSON from tunnel ${tunnelId}, message dropped`, {
        preview: data.slice(0, 200),
      });
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
   * Send a broker reply to an agent or peer broker.
   * Prefer an active WebSocket/tunnel route, then HTTP wake-up for agents.
   */
  private async sendReply(reply: BrokerMessage): Promise<void> {
    await this.replyDispatcher.sendReply(reply);
  }

  private findReplySocket(agentId: string): WebSocket | null {
    const connectedAgentSocket = this.connectedAgents.getSocket(agentId);
    if (connectedAgentSocket) return connectedAgentSocket;
    const tunnelSocket = this.tunnelRegistry.findReplySocket(agentId);
    if (tunnelSocket) return tunnelSocket;
    return this.tunnelRegistry.findRemoteBrokerConnection(agentId)?.ws ?? null;
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
    await this.toolExecution.close?.();
  }
}
