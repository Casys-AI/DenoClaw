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
  listCronJobs,
  listTaskObservations,
} from "./monitoring.ts";
import {
  getTrace,
  getTraceSpans,
  listAgentTraces,
} from "../telemetry/traces.ts";
import { RateLimiter } from "./rate_limit.ts";
import { GitHubOAuth } from "./github_oauth.ts";
import { AgentStore } from "./agent_store.ts";
import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

export type DashboardAuthMode = "local-open" | "token" | "github-oauth";
export const GATEWAY_WS_IDLE_TIMEOUT_SECONDS = 30;
const GATEWAY_WS_MAX_BUFFERED_AMOUNT = 1_000_000;

export interface GatewayWsChatPayload {
  type: "chat";
  message: string;
  agentId: string;
  sessionId?: string;
}

export function parseGatewayWsChatPayload(raw: string): GatewayWsChatPayload {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "payload", expected: "valid JSON string" },
      'Send a JSON payload like {"type":"chat","agentId":"...","message":"..."}',
    );
  }

  if (typeof data !== "object" || data === null) {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "payload", expected: "object" },
      "Send a JSON object payload",
    );
  }

  const record = data as Record<string, unknown>;
  if (record.type !== "chat") {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "type", expected: "chat" },
      'Only {"type":"chat", ...} messages are accepted on /ws',
    );
  }
  if (
    typeof record.agentId !== "string" || record.agentId.trim().length === 0
  ) {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "agentId" },
      "Provide a non-empty 'agentId' in the message",
    );
  }
  if (
    typeof record.message !== "string" || record.message.trim().length === 0
  ) {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "message" },
      "Provide a non-empty 'message' in the payload",
    );
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "sessionId" },
      "Provide 'sessionId' as a string when present",
    );
  }

  return {
    type: "chat",
    agentId: record.agentId,
    message: record.message,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

function sendGatewayWsJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > GATEWAY_WS_MAX_BUFFERED_AMOUNT) {
    socket.close(1013, "Gateway WebSocket saturated");
    throw new DenoClawError(
      "WS_BACKPRESSURE",
      {
        bufferedAmount: socket.bufferedAmount,
        maxBufferedAmount: GATEWAY_WS_MAX_BUFFERED_AMOUNT,
      },
      "Reconnect after the WebSocket send buffer drains",
    );
  }
  socket.send(JSON.stringify(payload));
}

export function getDashboardAuthMode(): DashboardAuthMode {
  const raw = Deno.env.get("DENOCLAW_DASHBOARD_AUTH_MODE");
  if (raw) {
    const v = raw.trim().toLowerCase();
    if (v === "token") return "token";
    if (v === "github" || v === "github-oauth" || v === "oauth") {
      return "github-oauth";
    }
  }
  return Deno.env.get("DENO_DEPLOYMENT_ID") ? "github-oauth" : "local-open";
}

export function getDashboardAllowedUsers(): string[] | undefined {
  const raw = Deno.env.get("DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS") ??
    Deno.env.get("GITHUB_ALLOWED_USERS");
  if (!raw) return undefined;
  const users = raw.split(",").map((u) => u.trim()).filter(Boolean);
  return users.length > 0 ? users : undefined;
}

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
    if (this.githubOAuth) {
      if (url.pathname === "/auth/github") {
        return await this.githubOAuth.handleAuthorize(req);
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
      (url.pathname.startsWith(this.dashboardBasePath) ||
        url.pathname === this.dashboardBasePath ||
        url.pathname === "/favicon.ico")
    ) {
      if (
        getDashboardAuthMode() === "github-oauth" &&
        url.pathname !== `${this.dashboardBasePath}/login`
      ) {
        const user = this.githubOAuth
          ? await this.githubOAuth.verifySession(req)
          : null;
        if (!user) {
          const loginUrl = new URL(
            `${this.dashboardBasePath}/login`,
            url.origin,
          );
          loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
          return Response.redirect(loginUrl.toString(), 302);
        }
      }

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

    // ── Agent CRUD (KV-backed) ──
    if (
      this.agentStore && url.pathname === "/api/agents" && req.method === "GET"
    ) {
      const registry = await this.agentStore.list();
      return Response.json(registry);
    }

    if (
      this.agentStore && url.pathname === "/api/agents" && req.method === "POST"
    ) {
      try {
        const body = await req.json() as {
          agentId: string;
          config: import("../shared/types.ts").AgentEntry;
        };
        if (!body.agentId || !body.config) {
          return Response.json({
            error: {
              code: "INVALID_INPUT",
              recovery: "Provide agentId and config",
            },
          }, { status: 400 });
        }
        await this.agentStore.set(body.agentId, body.config);
        // Hot-add to worker pool
        try {
          await this.workerPool.addAgent(body.agentId, body.config);
        } catch { /* agent may already be running */ }
        return Response.json({ ok: true, agentId: body.agentId });
      } catch (e) {
        return Response.json({
          error: {
            code: "INVALID_JSON",
            context: { message: (e as Error).message },
          },
        }, { status: 400 });
      }
    }

    if (
      this.agentStore && url.pathname.startsWith("/api/agents/") &&
      req.method === "DELETE"
    ) {
      const agentId = url.pathname.split("/api/agents/")[1];
      if (!agentId) {
        return Response.json({ error: { code: "MISSING_AGENT_ID" } }, {
          status: 400,
        });
      }
      const deleted = await this.agentStore.delete(agentId);
      if (deleted) this.workerPool.removeAgent(agentId);
      return Response.json({ ok: deleted, agentId });
    }

    if (
      this.agentStore && url.pathname.startsWith("/api/agents/") &&
      req.method === "GET"
    ) {
      const agentId = url.pathname.split("/api/agents/")[1];
      const config = await this.agentStore.get(agentId);
      if (!config) {
        return Response.json({ error: { code: "AGENT_NOT_FOUND" } }, {
          status: 404,
        });
      }
      return Response.json({ agentId, config });
    }

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
      const { socket, response } = Deno.upgradeWebSocket(req, {
        idleTimeout: GATEWAY_WS_IDLE_TIMEOUT_SECONDS,
      });

      socket.onopen = () => {
        this.wsClients.set(token, socket);
        log.info(`WebSocket connecté : ${token}`);
      };

      socket.onmessage = async (e) => {
        try {
          if (typeof e.data !== "string") {
            throw new DenoClawError(
              "INVALID_INPUT",
              { field: "payload", expected: "text frame" },
              "Binary WebSocket frames are not supported on /ws",
            );
          }

          const data = parseGatewayWsChatPayload(e.data);
          const sessionId = data.sessionId || `ws-${token}`;
          await this.session.getOrCreate(sessionId, token, "websocket");

          const result = await this.workerPool.send(
            data.agentId,
            sessionId,
            data.message,
          );
          sendGatewayWsJson(socket, {
            type: "response",
            sessionId,
            content: result.content,
          });
        } catch (err) {
          log.error("Erreur WebSocket message", err);
          if (err instanceof DenoClawError) {
            sendGatewayWsJson(socket, {
              type: "error",
              error: err.toStructured(),
            });
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          sendGatewayWsJson(socket, {
            type: "error",
            error: {
              code: "WS_MESSAGE_FAILED",
              context: { message: msg },
              recovery: "Check message format",
            },
          });
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

    // ── Task observation endpoints (before the /agents/ wildcard) ──

    if (url.pathname === "/tasks/observations") {
      if (!this.kv) return Response.json([]);
      return Response.json(await listTaskObservations(this.kv));
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
