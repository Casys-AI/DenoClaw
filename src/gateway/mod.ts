import type { ChannelMessage, Config } from "../types.ts";
import { getChannelManager } from "../channels/manager.ts";
import { TelegramChannel } from "../channels/telegram.ts";
import { WebhookChannel } from "../channels/webhook.ts";
import { getMessageBus } from "../bus/mod.ts";
import { getSessionManager } from "../session/mod.ts";
import { AgentLoop } from "../agent/loop.ts";
import { log } from "../utils/log.ts";

/**
 * Gateway — central orchestrator.
 * Wires channels, bus, sessions and agent loop together.
 * Uses Deno.serve() for the HTTP API endpoint.
 */
export class Gateway {
  private config: Config;
  private httpServer?: Deno.HttpServer;
  private running = false;
  private wsClients = new Map<string, WebSocket>();

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info("Démarrage du gateway...");

    const cm = getChannelManager();
    const bus = getMessageBus();
    await bus.init();

    // WebSocket connections for real-time clients / relay tunnels
    this.wsClients = new Map();

    // Register configured channels
    if (this.config.channels?.telegram?.enabled) {
      const tg = new TelegramChannel(this.config.channels.telegram);
      await tg.initialize();
      cm.register(tg);
    }

    if (this.config.channels?.webhook?.enabled) {
      const wh = new WebhookChannel(this.config.channels.webhook);
      await wh.initialize();
      cm.register(wh);
    }

    // Subscribe bus → handle messages
    bus.subscribeAll(async (msg) => await this.handleMessage(msg));

    // Start all channels
    await cm.startAll();

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
    await getChannelManager().stopAll();
    getMessageBus().close();

    this.running = false;
    log.info("Gateway arrêté");
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    log.info(`Message de ${msg.channelType} (user: ${msg.userId})`);

    try {
      const sm = getSessionManager();
      await sm.getOrCreate(msg.sessionId, msg.userId, msg.channelType);

      const agent = new AgentLoop(msg.sessionId, this.config);
      const result = await agent.processMessage(msg.content);

      await getChannelManager().send(
        msg.channelType,
        msg.userId,
        result.content,
        msg.metadata,
      );
    } catch (e) {
      log.error("Erreur traitement message", e);
      try {
        await getChannelManager().send(
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

  private async handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        channels: getChannelManager().getAllStatuses(),
        sessions: (await getSessionManager().getActive()).length,
      });
    }

    // POST /chat — direct API
    if (req.method === "POST" && url.pathname === "/chat") {
      try {
        const body = await req.json() as {
          message: string;
          sessionId?: string;
          model?: string;
        };

        const sessionId = body.sessionId || crypto.randomUUID();
        const sm = getSessionManager();
        await sm.getOrCreate(sessionId, "api", "http");

        const agent = new AgentLoop(sessionId, this.config, body.model ? { model: body.model } : undefined);
        const result = await agent.processMessage(body.message);

        return Response.json({ sessionId, response: result.content });
      } catch (e) {
        log.error("Erreur API /chat", e);
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }

    // WebSocket upgrade — /ws?token=xxx
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
            const sm = getSessionManager();
            await sm.getOrCreate(sessionId, token, "websocket");

            const agent = new AgentLoop(sessionId, this.config);
            const result = await agent.processMessage(data.message);

            socket.send(JSON.stringify({
              type: "response",
              sessionId,
              content: result.content,
            }));
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
