import { Bot, GrammyError, HttpError } from "grammy";
import { BaseChannel, type OnMessage } from "./base.ts";
import type {
  ChannelMessage,
  OutboundChannelMessage,
  TelegramConfig,
} from "../types.ts";
import { generateId } from "../../shared/helpers.ts";
import { ConfigError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

/**
 * Telegram channel — powered by grammY long polling.
 * Keeps Telegram transport concerns local to this adapter while preserving the
 * DenoClaw channel contract.
 */
export class TelegramChannel extends BaseChannel {
  private readonly config: TelegramChannelConfig;
  private running = false;
  private token?: string;
  private bot?: Bot;
  private pollingPromise?: Promise<void>;
  private botUsername?: string;
  private botApiId?: string;

  constructor(config: TelegramChannelConfig) {
    super("telegram", {
      adapterId: config.adapterId,
      accountId: config.accountId,
    });
    this.config = config;
    this.enabled = config.enabled;
  }

  async initialize(): Promise<void> {
    this.token = resolveTelegramToken(this.config);
    if (!this.token) {
      log.warn(
        `Telegram: no token configured for ${this.adapterId}${
          this.config.tokenEnvVar ? ` (${this.config.tokenEnvVar})` : ""
        }`,
      );
      this.enabled = false;
      return;
    }

    const bot = new Bot(this.token);
    bot.catch((error) => {
      log.error(
        `Telegram: grammY update error (${this.adapterId})`,
        formatTelegramPollingError(error.error),
      );
    });
    bot.on("message:text", async (ctx) => {
      await this.handleUpdate(ctx.update as TelegramUpdate);
    });

    try {
      await bot.init();
    } catch (error) {
      log.error(
        `Telegram: failed to initialize ${this.adapterId}`,
        formatTelegramPollingError(error),
      );
      this.enabled = false;
      return;
    }

    this.bot = bot;
    this.botUsername = bot.botInfo?.username;
    this.botApiId = typeof bot.botInfo?.id === "number"
      ? String(bot.botInfo.id)
      : undefined;
    this.setRoutingAccountId(this.config.accountId);

    log.info(
      `Telegram: connected as @${
        this.botUsername ?? this.botApiId ?? "unknown-bot"
      } (${this.adapterId})`,
    );
  }

  start(onMessage: OnMessage): void {
    this.onMessage = onMessage;
    if (!this.enabled || !this.bot) return;
    if (this.running || this.bot.isRunning()) return;

    this.running = true;
    log.info(`Telegram: polling started (${this.adapterId})`);
    this.pollingPromise = this.bot.start({
      allowed_updates: ["message"],
      onStart: () => {
        log.debug(`Telegram: grammY long polling active (${this.adapterId})`);
      },
    }).catch((error) => {
      if (this.running) {
        log.error(
          `Telegram: polling error (${this.adapterId})`,
          formatTelegramPollingError(error),
        );
      }
    }).finally(() => {
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    if (!this.bot) return;

    const pollingPromise = this.pollingPromise;
    if (this.bot.isRunning() || this.running) {
      this.running = false;
      this.bot.stop();
    }
    this.pollingPromise = undefined;
    if (pollingPromise) {
      await pollingPromise;
    }
    log.info(`Telegram: polling stopped (${this.adapterId})`);
  }

  async send(message: OutboundChannelMessage): Promise<void> {
    if (!this.bot) {
      log.warn(`Telegram: bot is not initialized for ${this.adapterId}`);
      return;
    }

    const chatId = message.address.roomId ?? message.address.userId;
    if (!chatId) {
      log.warn("Telegram: missing roomId/userId in outbound address");
      return;
    }

    const sendOptions = buildTelegramSendOptions(message);
    try {
      await this.bot.api.sendMessage(chatId, message.content, {
        ...sendOptions,
        parse_mode: "Markdown",
      });
      return;
    } catch (error) {
      if (!isTelegramMarkdownParseError(error)) {
        log.error(
          `Telegram: send error (${this.adapterId})`,
          formatTelegramSendError(error),
        );
        return;
      }
    }

    try {
      await this.bot.api.sendMessage(chatId, message.content, sendOptions);
    } catch (error) {
      log.error(
        `Telegram: send error (${this.adapterId})`,
        formatTelegramSendError(error),
      );
    }
  }

  isConnected(): boolean {
    return this.bot?.isRunning() ?? false;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const channelMessage = this.createChannelMessage(update);
    if (!channelMessage) return;
    await this.onMessage?.(channelMessage);
  }

  private createChannelMessage(update: TelegramUpdate): ChannelMessage | null {
    const msg = update.message;
    if (!msg?.text || !msg.from) return null;

    const userId = msg.from.id.toString();
    const roomId = msg.chat.id.toString();
    const threadId = typeof msg.message_thread_id === "number"
      ? msg.message_thread_id.toString()
      : undefined;
    if (!this.isAuthorized(userId, this.config.allowFrom)) return null;

    return {
      id: generateId(),
      sessionId: buildTelegramSessionId(this.accountId, roomId, threadId),
      userId,
      content: msg.text,
      channelType: "telegram",
      timestamp: new Date(msg.date * 1000).toISOString(),
      address: {
        channelType: "telegram",
        ...(this.accountId ? { accountId: this.accountId } : {}),
        userId,
        roomId,
        ...(threadId ? { threadId } : {}),
        replyToMessageId: msg.message_id.toString(),
      },
      metadata: {
        messageId: msg.message_id,
        chatId: msg.chat.id,
        ...(threadId ? { messageThreadId: threadId } : {}),
        username: msg.from.username,
        firstName: msg.from.first_name,
        ...(this.accountId ? { botAccountId: this.accountId } : {}),
        ...(this.botUsername ? { botUsername: this.botUsername } : {}),
        ...(this.botApiId ? { botApiId: this.botApiId } : {}),
      },
    };
  }
}

export interface TelegramChannelConfig {
  enabled: boolean;
  adapterId: string;
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
}

export function resolveTelegramChannelConfigs(
  config?: TelegramConfig,
): TelegramChannelConfig[] {
  if (!config?.enabled) return [];

  const normalized: TelegramChannelConfig[] = [];
  const seenAccountIds = new Set<string>();

  for (const account of config.accounts ?? []) {
    const accountId = normalizeAccountId(account.accountId);
    if (!accountId) {
      throw new ConfigError(
        "CHANNEL_CONFIG_INVALID",
        {
          channelType: "telegram",
          account,
        },
        "Set a non-empty Telegram accountId for each configured bot",
      );
    }
    if (seenAccountIds.has(accountId)) {
      throw new ConfigError(
        "CHANNEL_CONFIG_INVALID",
        {
          channelType: "telegram",
          accountId,
        },
        "Use a unique Telegram accountId for each configured bot",
      );
    }
    seenAccountIds.add(accountId);

    normalized.push({
      enabled: true,
      adapterId: buildTelegramAdapterId(accountId),
      accountId,
      ...(account.token ? { token: account.token } : {}),
      ...(account.tokenEnvVar ? { tokenEnvVar: account.tokenEnvVar } : {}),
      ...(account.allowFrom ? { allowFrom: account.allowFrom } : {}),
    });
  }

  return normalized;
}

function normalizeAccountId(accountId?: string): string | undefined {
  if (typeof accountId !== "string") return undefined;
  const normalized = accountId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildTelegramAdapterId(accountId?: string): string {
  const normalized = normalizeAccountId(accountId);
  return normalized ? `telegram:${normalized}` : "telegram";
}

function buildTelegramSessionId(
  accountId: string | undefined,
  roomId: string,
  threadId?: string,
): string {
  const scope = normalizeAccountId(accountId) ?? "default";
  return `telegram:${scope}:${threadId ?? roomId}`;
}

function resolveTelegramToken(
  config: TelegramChannelConfig,
): string | undefined {
  if (config.token) return config.token;
  if (!config.tokenEnvVar) return undefined;
  const token = Deno.env.get(config.tokenEnvVar);
  return typeof token === "string" && token.trim().length > 0
    ? token.trim()
    : undefined;
}

function buildTelegramSendOptions(
  message: OutboundChannelMessage,
): Record<string, unknown> {
  const threadId = normalizeTelegramThreadId(message.address.threadId);
  return typeof threadId === "number" ? { message_thread_id: threadId } : {};
}

function normalizeTelegramThreadId(threadId?: string): number | undefined {
  if (typeof threadId !== "string") return undefined;
  const parsed = Number.parseInt(threadId, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isTelegramMarkdownParseError(error: unknown): boolean {
  return error instanceof GrammyError &&
    error.description.toLowerCase().includes("can't parse");
}

function formatTelegramSendError(error: unknown): unknown {
  if (error instanceof GrammyError) {
    return {
      kind: "grammy_api_error",
      description: error.description,
      errorCode: error.error_code,
      parameters: error.parameters,
    };
  }
  if (error instanceof HttpError) {
    return {
      kind: "grammy_http_error",
      message: error.message,
      cause: error.error,
    };
  }
  return error;
}

function formatTelegramPollingError(error: unknown): unknown {
  if (error instanceof GrammyError || error instanceof HttpError) {
    return formatTelegramSendError(error);
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    date: number;
    text?: string;
    message_thread_id?: number;
    chat: { id: number };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
  };
}
