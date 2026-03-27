import { BaseChannel, type OnMessage } from "./base.ts";
import type { ChannelMessage, TelegramConfig } from "../types.ts";
import { generateId } from "../../shared/helpers.ts";
import { log } from "../../shared/log.ts";

/**
 * Telegram channel — pure fetch(), zéro dépendance npm.
 * Utilise le long polling de l'API Bot Telegram.
 */
export class TelegramChannel extends BaseChannel {
  private config: TelegramConfig;
  private running = false;
  private offset = 0;

  constructor(config: TelegramConfig) {
    super("telegram");
    this.config = config;
    this.enabled = config.enabled;
  }

  private get baseUrl(): string {
    return `https://api.telegram.org/bot${this.config.token}`;
  }

  async initialize(): Promise<void> {
    if (!this.config.token) {
      log.warn("Telegram: pas de token configuré");
      return;
    }

    // Vérifier que le token est valide
    const res = await fetch(`${this.baseUrl}/getMe`);
    if (!res.ok) {
      const text = await res.text();
      log.error(`Telegram: token invalide — ${text}`);
      this.enabled = false;
      return;
    }

    const data = await res.json() as { result: { username: string } };
    log.info(`Telegram: connecté en tant que @${data.result.username}`);
  }

  async start(onMessage: OnMessage): Promise<void> {
    this.onMessage = onMessage;
    this.running = true;
    log.info("Telegram: polling démarré");

    // Long polling loop
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.handleUpdate(update);
        }
      } catch (e) {
        if (this.running) {
          log.error("Telegram: erreur polling", e);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    log.info("Telegram: polling arrêté");
    await Promise.resolve();
  }

  async send(userId: string, content: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: parseInt(userId),
        text: content,
        parse_mode: "Markdown",
      }),
    });

    if (!res.ok) {
      // Retry sans Markdown si erreur de parsing
      const errBody = await res.text();
      if (errBody.includes("can't parse")) {
        await fetch(`${this.baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: parseInt(userId), text: content }),
        });
      } else {
        log.error(`Telegram: erreur envoi — ${errBody}`);
      }
    }
  }

  isConnected(): boolean {
    return this.running;
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const res = await fetch(`${this.baseUrl}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: this.offset,
        timeout: 30,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (!res.ok) return [];

    const data = await res.json() as { result: TelegramUpdate[] };
    return data.result || [];
  }

  private handleUpdate(update: TelegramUpdate): void {
    if (update.update_id >= this.offset) {
      this.offset = update.update_id + 1;
    }

    const msg = update.message;
    if (!msg?.text || !msg.from) return;

    const userId = msg.from.id.toString();

    if (!this.isAuthorized(userId, this.config.allowFrom)) return;

    const channelMessage: ChannelMessage = {
      id: generateId(),
      sessionId: `telegram-${userId}`,
      userId,
      content: msg.text,
      channelType: "telegram",
      timestamp: new Date(msg.date * 1000).toISOString(),
      metadata: {
        messageId: msg.message_id,
        chatId: msg.chat.id,
        username: msg.from.username,
        firstName: msg.from.first_name,
      },
    };

    this.onMessage?.(channelMessage);
  }
}

// Telegram API types (minimal)
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
  };
}
