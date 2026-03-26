import { BaseChannel, type OnMessage } from "./base.ts";
import type { ChannelMessage, WebhookConfig } from "../types.ts";
import { generateId } from "../utils/helpers.ts";
import { log } from "../utils/log.ts";

/**
 * Generic webhook channel — receives messages via HTTP POST,
 * sends responses back to a callback URL.
 * Uses Deno.serve() natively.
 */
export class WebhookChannel extends BaseChannel {
  private config: WebhookConfig;
  private server?: Deno.HttpServer;

  constructor(config: WebhookConfig) {
    super("webhook");
    this.config = config;
    this.enabled = config.enabled;
  }

  async initialize(): Promise<void> {
    log.debug("Webhook channel initialisé");
    await Promise.resolve();
  }

  start(onMessage: OnMessage): void {
    this.onMessage = onMessage;
    const port = this.config.port || 8787;

    this.server = Deno.serve({ port }, async (req) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      // Optional secret check
      if (this.config.secret) {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${this.config.secret}`) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      try {
        const body = await req.json() as {
          userId?: string;
          content?: string;
          sessionId?: string;
          callbackUrl?: string;
        };

        const msg: ChannelMessage = {
          id: generateId(),
          sessionId: body.sessionId || `webhook-${body.userId || "anon"}`,
          userId: body.userId || "webhook",
          content: body.content || "",
          channelType: "webhook",
          timestamp: new Date().toISOString(),
          metadata: { callbackUrl: body.callbackUrl },
        };

        this.onMessage?.(msg);

        return Response.json({ ok: true, messageId: msg.id });
      } catch (e) {
        log.error("Erreur webhook", e);
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
    });

    log.info(`Webhook channel démarré sur port ${port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      log.info("Webhook channel arrêté");
    }
  }

  async send(_userId: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const callbackUrl = metadata?.callbackUrl as string;
    if (!callbackUrl) {
      log.warn("Pas de callbackUrl pour webhook send");
      return;
    }

    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  isConnected(): boolean {
    return this.server !== undefined;
  }
}
