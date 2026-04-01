import { BaseChannel, type OnMessage } from "./base.ts";
import type {
  ChannelMessage,
  OutboundChannelMessage,
  WebhookConfig,
} from "../types.ts";
import { generateId } from "../../shared/helpers.ts";
import { log } from "../../shared/log.ts";

type WebhookServe = (
  options: Deno.ServeTcpOptions,
  handler: (req: Request) => Response | Promise<Response>,
) => Deno.HttpServer;

/**
 * Generic webhook channel — receives messages via HTTP POST,
 * returns 202 + taskId and expects callers to query task state separately.
 * Uses Deno.serve() natively.
 */
export class WebhookChannel extends BaseChannel {
  private config: WebhookConfig;
  private server?: Deno.HttpServer;
  private serve: WebhookServe;

  constructor(
    config: WebhookConfig,
    deps: { serve?: WebhookServe } = {},
  ) {
    super("webhook");
    this.config = config;
    this.enabled = config.enabled;
    this.serve = deps.serve ?? Deno.serve;
  }

  async initialize(): Promise<void> {
    log.debug("Webhook channel initialized");
    await Promise.resolve();
  }

  start(onMessage: OnMessage): void {
    this.onMessage = onMessage;
    const port = this.config.port || 8787;

    this.server = this.serve({ port }, async (req) => {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, channel: "webhook" });
      }

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
          agentId?: string;
        };
        const taskId = generateId();
        const messageId = generateId();

        const msg: ChannelMessage = {
          id: messageId,
          sessionId: body.sessionId || `webhook-${body.userId || "anon"}`,
          userId: body.userId || "webhook",
          content: body.content || "",
          channelType: "webhook",
          timestamp: new Date().toISOString(),
          address: {
            channelType: "webhook",
            userId: body.userId || "webhook",
          },
          metadata: {
            taskId,
            ...(body.agentId ? { agentId: body.agentId } : {}),
          },
        };

        await this.onMessage?.(msg);

        return Response.json(
          {
            ok: true,
            accepted: true,
            taskId,
            messageId,
            taskStatusPath: `/ingress/tasks/${encodeURIComponent(taskId)}`,
          },
          { status: 202 },
        );
      } catch (e) {
        log.error("Webhook error", e);
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
    });

    log.info(`Webhook channel started on port ${port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      log.info("Webhook channel stopped");
    }
  }

  async send(message: OutboundChannelMessage): Promise<void> {
    log.debug(
      "Webhook outbound push disabled; query task state via the ingress API",
      {
        channelType: message.address.channelType,
        userId: message.address.userId,
      },
    );
    await Promise.resolve();
  }

  isConnected(): boolean {
    return this.server !== undefined;
  }
}
