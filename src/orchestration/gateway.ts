import type { ChannelMessage } from "../messaging/types.ts";
import type { Config } from "../config/types.ts";
import type { MessageBus } from "../messaging/bus.ts";
import type { SessionManager } from "../messaging/session.ts";
import type { ChannelManager } from "../messaging/channels/manager.ts";
import type { AuthManager, AuthResult } from "./auth.ts";
import type { WorkerPool } from "../agent/worker_pool.ts";
import type { MetricsCollector } from "../telemetry/metrics.ts";
import { TelegramChannel } from "../messaging/channels/telegram.ts";
import { WebhookChannel } from "../messaging/channels/webhook.ts";
import { generateAllCards } from "../messaging/a2a/card.ts";
import {
  createSSEResponse,
  getAgentStatus,
  listAgentStatuses,
  listAgentTasks,
  listCronJobs,
} from "./monitoring.ts";
import {
  getTrace,
  getTraceSpans,
  listAgentTraces,
} from "../telemetry/traces.ts";
import { RateLimiter } from "./rate_limit.ts";
import { GitHubOAuth } from "./github_oauth.ts";
import { log } from "../shared/log.ts";

export interface GatewayDeps {
  bus: MessageBus;
  session: SessionManager;
  channels: ChannelManager;
  workerPool: WorkerPool;
  auth?: AuthManager;
  metrics?: MetricsCollector;
  kv?: Deno.Kv;
  freshHandler?: (req: Request) => Promise<Response>;
}

/**
 * Gateway — central orchestrator (mode local).
 * Wires channels, bus, sessions and agent loop together.
 * Toutes les dépendances injectées via constructeur (DI).
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
  private rateLimiter: RateLimiter | null = null;
  private githubOAuth: GitHubOAuth | null = null;
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
    if (this.kv) {
      this.rateLimiter = new RateLimiter(this.kv, 100, 60_000);
      this.githubOAuth = new GitHubOAuth(this.kv, ["superWorldSavior"]);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info("Démarrage du gateway...");

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
    log.info(`Gateway démarré — API sur port ${port}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    log.info("Arrêt du gateway...");

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
    log.info("Gateway arrêté");
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    log.info(`Message de ${msg.channelType} (user: ${msg.userId})`);

    try {
      await this.session.getOrCreate(
        msg.sessionId,
        msg.userId,
        msg.channelType,
      );

      const agentId = msg.metadata?.agentId as string | undefined;
      if (!agentId) {
        log.error("Message sans agentId — ignoré");
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
      log.error("Erreur traitement message", e);
      try {
        await this.channels.send(
          msg.channelType,
          msg.userId,
          "Désolé, une erreur s'est produite. Réessayez.",
          msg.metadata,
        );
      } catch {
        // ignore send failure
      }
    }
  }

  private async checkAuth(req: Request): Promise<Response | null> {
    if (!this.auth) {
      // Pas d'AuthManager injecté — fallback static token (mode local)
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
    const url = new URL(req.url);

    // GitHub OAuth routes — before auth (public endpoints)
    if (this.githubOAuth?.isConfigured()) {
      if (url.pathname === "/auth/github") {
        return this.githubOAuth.handleAuthorize(req);
      }
      if (url.pathname === "/auth/github/callback") {
        return await this.githubOAuth.handleCallback(req);
      }
      if (url.pathname === "/auth/logout") {
        return await this.githubOAuth.handleLogout(req);
      }
    }

    // Dashboard Fresh handler — avant auth (gère sa propre auth si besoin)
    if (
      this.freshHandler &&
      (url.pathname.startsWith("/ui") || url.pathname === "/favicon.ico")
    ) {
      return await this.freshHandler(req);
    }

    if (url.pathname === "/") {
      return new Response("DenoClaw Gateway");
    }

    // Rate limiting — before auth to block floods early
    if (this.rateLimiter) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "unknown";
      const rl = await this.rateLimiter.check(ip);
      if (!rl.allowed) return this.rateLimiter.denyResponse(rl);
    }

    const authErr = await this.checkAuth(req);
    if (authErr) return authErr;

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        channels: this.channels.getAllStatuses(),
        sessions: (await this.session.getActive()).length,
      });
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      try {
        const body = await req.json() as {
          message: string;
          sessionId?: string;
          model?: string;
          agentId: string;
        };

        // AX-5: validate at the boundary
        if (!body.message || typeof body.message !== "string") {
          return Response.json(
            {
              error: {
                code: "INVALID_INPUT",
                context: { field: "message" },
                recovery:
                  "Provide a non-empty 'message' string in the JSON body",
              },
            },
            { status: 400 },
          );
        }
        if (!body.agentId || typeof body.agentId !== "string") {
          return Response.json(
            {
              error: {
                code: "INVALID_INPUT",
                context: { field: "agentId" },
                recovery: "Provide 'agentId' in the JSON body",
              },
            },
            { status: 400 },
          );
        }

        const sessionId = body.sessionId || crypto.randomUUID();
        await this.session.getOrCreate(sessionId, "api", "http");

        const result = await this.workerPool.send(
          body.agentId,
          sessionId,
          body.message,
          {
            model: body.model,
          },
        );
        return Response.json({ sessionId, response: result.content });
      } catch (e) {
        log.error("Erreur API /chat", e);
        // AX-3: structured error output
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json(
          {
            error: {
              code: "CHAT_FAILED",
              context: { message: msg },
              recovery: "Check message format and provider configuration",
            },
          },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/ws") {
      const upgrade = req.headers.get("upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const token = url.searchParams.get("token") || crypto.randomUUID();
      const { socket, response } = Deno.upgradeWebSocket(req);

      socket.onopen = () => {
        this.wsClients.set(token, socket);
        log.info(`WebSocket connecté : ${token}`);
      };

      socket.onmessage = async (e) => {
        try {
          const data = JSON.parse(e.data as string) as {
            type: string;
            message?: string;
            sessionId?: string;
            agentId?: string;
          };

          if (data.type === "chat" && data.message) {
            if (!data.agentId) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: {
                    code: "INVALID_INPUT",
                    context: { field: "agentId" },
                    recovery: "Provide 'agentId' in the message",
                  },
                }),
              );
              return;
            }
            const sessionId = data.sessionId || `ws-${token}`;
            await this.session.getOrCreate(sessionId, token, "websocket");

            const result = await this.workerPool.send(
              data.agentId,
              sessionId,
              data.message,
            );
            socket.send(JSON.stringify({
              type: "response",
              sessionId,
              content: result.content,
            }));
          }
        } catch (err) {
          log.error("Erreur WebSocket message", err);
          const msg = err instanceof Error ? err.message : String(err);
          socket.send(
            JSON.stringify({
              type: "error",
              error: {
                code: "WS_MESSAGE_FAILED",
                context: { message: msg },
                recovery: "Check message format",
              },
            }),
          );
        }
      };

      socket.onclose = () => {
        this.wsClients.delete(token);
        log.info(`WebSocket déconnecté : ${token}`);
      };

      return response;
    }

    // ── Monitoring endpoints ─────────────────────────────

    if (url.pathname === "/stats") {
      if (!this.metrics) {
        return Response.json({
          mode: "local",
          agents: this.workerPool.getAgentIds(),
          sessions: (await this.session.getActive()).length,
        });
      }
      const agentId = url.searchParams.get("agent");
      if (agentId) {
        return Response.json(await this.metrics.getAgentMetrics(agentId));
      }
      return Response.json(await this.metrics.getSummary());
    }

    if (url.pathname === "/stats/agents") {
      if (!this.metrics) {
        return Response.json(
          {
            error: {
              code: "NO_METRICS",
              recovery: "Pass MetricsCollector to GatewayDeps",
            },
          },
          { status: 503 },
        );
      }
      return Response.json(await this.metrics.getAllMetrics());
    }

    // ── Agent task endpoints (before the /agents/ wildcard) ──

    if (url.pathname === "/agents/tasks") {
      if (!this.kv) return Response.json([]);
      return Response.json(await listAgentTasks(this.kv));
    }

    if (
      url.pathname.match(/^\/agents\/[^/]+\/task$/) && req.method === "POST"
    ) {
      const agentName = url.pathname.split("/")[2];
      if (!agentName) return new Response("Not Found", { status: 404 });

      if (!this.workerPool.isReady(agentName)) {
        return Response.json(
          {
            error: {
              code: "AGENT_NOT_FOUND",
              context: { agentId: agentName },
              recovery: "Check agent name",
            },
          },
          { status: 404 },
        );
      }

      try {
        const body = await req.json() as {
          message: string;
          sessionId?: string;
        };
        if (!body.message) {
          return Response.json(
            {
              error: {
                code: "INVALID_INPUT",
                context: { field: "message" },
                recovery: "Provide a message",
              },
            },
            { status: 400 },
          );
        }
        const sessionId = body.sessionId || `agent-task-${crypto.randomUUID()}`;
        const result = await this.workerPool.send(
          agentName,
          sessionId,
          body.message,
        );
        return Response.json({ agentId: agentName, response: result.content });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json(
          {
            error: {
              code: "AGENT_TASK_FAILED",
              context: { message: msg },
              recovery: "Check agent and message",
            },
          },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/agents") {
      if (!this.kv) {
        // Fallback: return agent IDs from WorkerPool without status
        return Response.json(
          this.workerPool.getAgentIds().map((id) => ({
            agentId: id,
            status: this.workerPool.isReady(id) ? "running" : "stopped",
          })),
        );
      }
      return Response.json(await listAgentStatuses(this.kv));
    }

    // ── Trace endpoints (before /agents/:id to avoid conflicts) ──

    if (url.pathname.startsWith("/traces/") && this.kv) {
      const parts = url.pathname.split("/").filter(Boolean);
      const traceId = parts[1];
      if (parts[2] === "spans") {
        return Response.json(await getTraceSpans(this.kv, traceId));
      }
      const trace = await getTrace(this.kv, traceId);
      if (!trace) {
        return Response.json({ error: { code: "TRACE_NOT_FOUND" } }, {
          status: 404,
        });
      }
      return Response.json(trace);
    }

    if (
      url.pathname.startsWith("/agents/") && url.pathname.endsWith("/traces") &&
      this.kv
    ) {
      const agentId = url.pathname.split("/")[2];
      const limit = parseInt(url.searchParams.get("limit") ?? "20");
      return Response.json(await listAgentTraces(this.kv, agentId, limit));
    }

    if (url.pathname.startsWith("/agents/")) {
      const agentId = url.pathname.split("/")[2];
      if (!agentId) return new Response("Not Found", { status: 404 });

      const status = this.kv ? await getAgentStatus(this.kv, agentId) : null;
      const metrics = this.metrics
        ? await this.metrics.getAgentMetrics(agentId)
        : null;

      if (!status && !metrics) {
        return Response.json(
          {
            error: {
              code: "AGENT_NOT_FOUND",
              context: { agentId },
              recovery: "Check agent ID",
            },
          },
          { status: 404 },
        );
      }

      return Response.json({ ...status, metrics });
    }

    // Hourly metrics history
    if (url.pathname === "/stats/history" && this.metrics) {
      const agentId = url.searchParams.get("agent") || "";
      const from = url.searchParams.get("from") ||
        new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const to = url.searchParams.get("to") || new Date().toISOString();
      if (!agentId) {
        return Response.json({
          error: { code: "MISSING_PARAM", recovery: "Add ?agent=<id>" },
        }, { status: 400 });
      }
      return Response.json(
        await this.metrics.getHourlyMetrics(agentId, from, to),
      );
    }

    // Per-tool breakdown
    if (url.pathname === "/stats/tools" && this.metrics) {
      const agentId = url.searchParams.get("agent") || "";
      if (!agentId) {
        return Response.json({
          error: { code: "MISSING_PARAM", recovery: "Add ?agent=<id>" },
        }, { status: 400 });
      }
      return Response.json(await this.metrics.getToolBreakdown(agentId));
    }

    // Hourly A2A history
    if (url.pathname === "/stats/a2a" && this.metrics) {
      const agentId = url.searchParams.get("agent") || "";
      const from = url.searchParams.get("from") ||
        new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const to = url.searchParams.get("to") || new Date().toISOString();
      if (!agentId) {
        return Response.json({
          error: { code: "MISSING_PARAM", recovery: "Add ?agent=<id>" },
        }, { status: 400 });
      }
      return Response.json(await this.metrics.getHourlyA2A(agentId, from, to));
    }

    // A2A frequency matrix
    if (url.pathname === "/stats/a2a/matrix" && this.metrics) {
      const from = url.searchParams.get("from") ||
        new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const to = url.searchParams.get("to") || new Date().toISOString();
      return Response.json(await this.metrics.getA2AFrequencyMatrix(from, to));
    }

    if (url.pathname === "/cron") {
      if (!this.kv) {
        return Response.json([]);
      }
      return Response.json(await listCronJobs(this.kv));
    }

    if (url.pathname === "/events") {
      if (!this.kv) {
        return Response.json(
          {
            error: { code: "NO_KV", recovery: "Pass shared KV to GatewayDeps" },
          },
          { status: 503 },
        );
      }
      const agentIds = this.workerPool.getAgentIds();
      return createSSEResponse(this.kv, agentIds);
    }

    // ── Discovery ─────────────────────────────────────────

    if (url.pathname === "/.well-known/agent-card.json") {
      if (!this.config.agents?.registry) {
        return Response.json([], { status: 200 });
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      const cards = generateAllCards(this.config.agents, baseUrl);
      return Response.json(cards);
    }

    return new Response("Not Found", { status: 404 });
  }

  getConnectedClients(): number {
    return this.wsClients.size;
  }

  isRunning(): boolean {
    return this.running;
  }
}
