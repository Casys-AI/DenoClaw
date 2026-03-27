import type { ChannelMessage } from "../messaging/types.ts";
import type { Config } from "../config/types.ts";
import type { MessageBus } from "../messaging/bus.ts";
import type { SessionManager } from "../messaging/session.ts";
import type { ChannelManager } from "../messaging/channels/manager.ts";
import type { AuthManager, AuthResult } from "./auth.ts";
import { TelegramChannel } from "../messaging/channels/telegram.ts";
import { WebhookChannel } from "../messaging/channels/webhook.ts";
import { AgentLoop } from "../agent/loop.ts";
import { log } from "../shared/log.ts";

export interface GatewayDeps {
  bus: MessageBus;
  session: SessionManager;
  channels: ChannelManager;
  auth?: AuthManager;
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
  private auth: AuthManager | null;
  private httpServer?: Deno.HttpServer;
  private running = false;
  private wsClients = new Map<string, WebSocket>();

  constructor(config: Config, deps: GatewayDeps) {
    this.config = config;
    this.bus = deps.bus;
    this.session = deps.session;
    this.channels = deps.channels;
    this.auth = deps.auth ?? null;
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
      try { ws.close(); } catch { /* ignore */ }
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
      await this.session.getOrCreate(msg.sessionId, msg.userId, msg.channelType);

      const agent = new AgentLoop(msg.sessionId, this.config);
      try {
        const result = await agent.processMessage(msg.content);
        await this.channels.send(
          msg.channelType,
          msg.userId,
          result.content,
          msg.metadata,
        );
      } finally {
        agent.close();
      }
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
        { error: { code: "UNAUTHORIZED", recovery: "Add Authorization: Bearer <token> header" } },
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

    if (url.pathname === "/") {
      return new Response("DenoClaw Gateway");
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
        };

        const sessionId = body.sessionId || crypto.randomUUID();
        await this.session.getOrCreate(sessionId, "api", "http");

        const agent = new AgentLoop(sessionId, this.config, body.model ? { model: body.model } : undefined);
        try {
          const result = await agent.processMessage(body.message);
          return Response.json({ sessionId, response: result.content });
        } finally {
          agent.close();
        }
      } catch (e) {
        log.error("Erreur API /chat", e);
        return Response.json({ error: (e as Error).message }, { status: 500 });
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
          };

          if (data.type === "chat" && data.message) {
            const sessionId = data.sessionId || `ws-${token}`;
            await this.session.getOrCreate(sessionId, token, "websocket");

            const agent = new AgentLoop(sessionId, this.config);
            try {
              const result = await agent.processMessage(data.message);
              socket.send(JSON.stringify({
                type: "response",
              sessionId,
              content: result.content,
            }));
            } finally {
              agent.close();
            }
          }
        } catch (err) {
          log.error("Erreur WebSocket message", err);
          socket.send(JSON.stringify({ type: "error", error: (err as Error).message }));
        }
      };

      socket.onclose = () => {
        this.wsClients.delete(token);
        log.info(`WebSocket déconnecté : ${token}`);
      };

      return response;
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
