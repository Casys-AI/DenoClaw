import type { ChannelMessage } from "../../messaging/types.ts";
import type { Config } from "../../config/types.ts";
import type { MessageBus } from "../../messaging/bus.ts";
import type { SessionManager } from "../../messaging/session.ts";
import type { ChannelManager } from "../../messaging/channels/manager.ts";
import type { AuthManager, AuthResult } from "../auth.ts";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import type { MetricsCollector } from "../../telemetry/metrics.ts";
import { TelegramChannel } from "../../messaging/channels/telegram.ts";
import { WebhookChannel } from "../../messaging/channels/webhook.ts";
import { RateLimiter } from "../rate_limit.ts";
import { GitHubOAuth } from "../github_oauth.ts";
import { AgentStore } from "../agent_store.ts";
import { log } from "../../shared/log.ts";
import {
  type DashboardAuthMode,
  getDashboardAllowedUsers,
  getDashboardAuthMode,
} from "./dashboard.ts";
import {
  GATEWAY_WS_IDLE_TIMEOUT_SECONDS,
  type GatewayWsChatPayload,
  handleGatewayWebSocketUpgrade,
  parseGatewayWsChatPayload,
} from "./ws_routes.ts";
import { type GatewayHttpContext, handleGatewayHttp } from "./http_routes.ts";

export {
  GATEWAY_WS_IDLE_TIMEOUT_SECONDS,
  getDashboardAllowedUsers,
  getDashboardAuthMode,
  handleGatewayWebSocketUpgrade,
  parseGatewayWsChatPayload,
};
export type { DashboardAuthMode, GatewayWsChatPayload };

export interface GatewayDeps {
  bus: MessageBus;
  session: SessionManager;
  channels: ChannelManager;
  workerPool: WorkerPool;
  auth?: AuthManager;
  metrics?: MetricsCollector;
  kv?: Deno.Kv;
  freshHandler?: (req: Request) => Promise<Response>;
  dashboardBasePath?: string;
}

/**
 * Gateway — central orchestrator (local mode).
 * Wires channels, bus, sessions and agent loop together.
 * All dependencies are injected through the constructor (DI).
 */
export class Gateway {
  private config: Config;
  private bus: MessageBus;
  private session: SessionManager;
  private channels: ChannelManager;
  private workerPool: WorkerPool;
  private auth: AuthManager | null;
  private metrics: MetricsCollector | null;
  private kv: Deno.Kv | null;
  private freshHandler: ((req: Request) => Promise<Response>) | null;
  private dashboardBasePath: string;
  private rateLimiter: RateLimiter | null = null;
  private githubOAuth: GitHubOAuth | null = null;
  private agentStore: AgentStore | null = null;
  private httpServer?: Deno.HttpServer;
  private running = false;
  private wsClients = new Map<string, WebSocket>();

  constructor(config: Config, deps: GatewayDeps) {
    this.config = config;
    this.bus = deps.bus;
    this.session = deps.session;
    this.channels = deps.channels;
    this.workerPool = deps.workerPool;
    this.auth = deps.auth ?? null;
    this.metrics = deps.metrics ?? null;
    this.kv = deps.kv ?? null;
    this.freshHandler = deps.freshHandler ?? null;
    this.dashboardBasePath = deps.dashboardBasePath ?? "/ui";
    if (this.kv) {
      this.rateLimiter = new RateLimiter(this.kv, 100, 60_000);
      this.githubOAuth = new GitHubOAuth(this.kv, {
        allowedUsers: getDashboardAllowedUsers(),
        dashboardBasePath: this.dashboardBasePath,
      });
      this.agentStore = new AgentStore(this.kv);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info("Starting gateway...");

    await this.bus.init();
    this.wsClients = new Map();

    // Register configured channels
    if (this.config.channels?.telegram?.enabled) {
      const tg = new TelegramChannel(this.config.channels.telegram);
      await tg.initialize();
      this.channels.register(tg);
    }

    if (this.config.channels?.webhook?.enabled) {
      const wh = new WebhookChannel(this.config.channels.webhook);
      await wh.initialize();
      this.channels.register(wh);
    }

    // Subscribe bus → handle messages
    this.bus.subscribeAll(async (msg) => await this.handleMessage(msg));

    // Start all channels
    await this.channels.startAll();

    // HTTP API gateway
    const port = this.config.gateway?.port || 3000;
    this.httpServer = Deno.serve({ port }, async (req) => {
      return await this.handleHttp(req);
    });

    this.running = true;
    log.info(`Gateway started — API on port ${port}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    log.info("Stopping gateway...");

    if (this.httpServer) await this.httpServer.shutdown();
    for (const ws of this.wsClients.values()) {
      try {
        ws.close();
      } catch { /* ignore */ }
    }
    this.wsClients.clear();
    await this.channels.stopAll();
    this.bus.close();

    this.running = false;
    log.info("Gateway stopped");
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    log.info(`Message from ${msg.channelType} (user: ${msg.userId})`);

    try {
      await this.session.getOrCreate(
        msg.sessionId,
        msg.userId,
        msg.channelType,
      );

      const agentId = msg.metadata?.agentId as string | undefined;
      if (!agentId) {
        log.error("Message without agentId — ignored");
        return;
      }
      const result = await this.workerPool.send(
        agentId,
        msg.sessionId,
        msg.content,
      );
      await this.channels.send(
        msg.channelType,
        msg.userId,
        result.content,
        msg.metadata,
      );
    } catch (e) {
      log.error("Message handling error", e);
      try {
        await this.channels.send(
          msg.channelType,
          msg.userId,
          "Sorry, an error occurred. Please try again.",
          msg.metadata,
        );
      } catch {
        // ignore send failure
      }
    }
  }

  private async checkAuth(req: Request): Promise<Response | null> {
    if (!this.auth) {
      // No AuthManager injected — fall back to a static token (local mode)
      const token = Deno.env.get("DENOCLAW_API_TOKEN");
      if (!token) return null;
      const auth = req.headers.get("authorization");
      const queryToken = new URL(req.url).searchParams.get("token");
      if (auth === `Bearer ${token}` || queryToken === token) return null;
      return Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            recovery: "Add Authorization: Bearer <token> header",
          },
        },
        { status: 401 },
      );
    }

    const result: AuthResult = await this.auth.checkRequest(req);
    if (!result.ok) {
      return Response.json(
        { error: { code: result.code, recovery: result.recovery } },
        { status: 401 },
      );
    }
    return null;
  }

  private async handleHttp(req: Request): Promise<Response> {
    return await handleGatewayHttp(this.createHttpContext(), req);
  }

  private createHttpContext(): GatewayHttpContext {
    return {
      config: this.config,
      session: this.session,
      channels: this.channels,
      workerPool: this.workerPool,
      metrics: this.metrics,
      kv: this.kv,
      freshHandler: this.freshHandler,
      dashboardBasePath: this.dashboardBasePath,
      rateLimiter: this.rateLimiter,
      githubOAuth: this.githubOAuth,
      agentStore: this.agentStore,
      checkAuth: (req) => this.checkAuth(req),
      handleWebSocketUpgrade: (req) =>
        handleGatewayWebSocketUpgrade(
          {
            session: this.session,
            workerPool: this.workerPool,
            wsClients: this.wsClients,
          },
          req,
        ),
    };
  }

  getConnectedClients(): number {
    return this.wsClients.size;
  }

  isRunning(): boolean {
    return this.running;
  }
}
