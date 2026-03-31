import { createBot } from "@discordeno/bot";
import { BaseChannel, type OnMessage } from "./base.ts";
import type {
  ChannelMessage,
  DiscordConfig,
  OutboundChannelMessage,
} from "../types.ts";
import { generateId } from "../../shared/helpers.ts";
import { ConfigError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

const DISCORD_GATEWAY_INTENTS = 1 | // Guilds
  512 | // GuildMessages
  4096 | // DirectMessages
  32768; // MessageContent

const DISCORD_DESIRED_PROPERTIES = {
  user: {
    id: true,
    username: true,
    bot: true,
  },
  channel: {
    id: true,
    type: true,
    parentId: true,
    internalThreadMetadata: true,
  },
  message: {
    id: true,
    content: true,
    channelId: true,
    guildId: true,
    timestamp: true,
    author: true,
  },
} as const;

type DiscordBotInstance = ReturnType<typeof createDiscordBotInstance>;
type DiscordResolvedScope = {
  roomId: string;
  threadId?: string;
};

export class DiscordChannel extends BaseChannel {
  private readonly config: DiscordChannelConfig;
  private running = false;
  private token?: string;
  private bot?: DiscordBotInstance;
  private startPromise?: Promise<void>;
  private botUsername?: string;
  private botUserId?: string;
  private readonly channelScopeCache = new Map<string, DiscordResolvedScope>();

  constructor(config: DiscordChannelConfig) {
    super("discord", {
      adapterId: config.adapterId,
      accountId: config.accountId,
    });
    this.config = config;
    this.enabled = config.enabled;
  }

  initialize(): Promise<void> {
    this.token = resolveDiscordToken(this.config);
    if (!this.token) {
      log.warn(
        `Discord: no token configured for ${this.adapterId}${
          this.config.tokenEnvVar ? ` (${this.config.tokenEnvVar})` : ""
        }`,
      );
      this.enabled = false;
      return Promise.resolve();
    }

    this.bot = createDiscordBotInstance(
      this.token,
      async (message) => {
        await this.handleMessageCreate(message as DiscordGatewayMessage);
      },
      (payload) => {
        this.botUserId = stringifySnowflake(payload.user?.id);
        this.botUsername = payload.user?.username;
        log.info(
          `Discord: connected as ${
            this.botUsername ? `@${this.botUsername}` : this.botUserId
          } (${this.adapterId})`,
        );
      },
    );

    this.setRoutingAccountId(this.config.accountId);
    return Promise.resolve();
  }

  start(onMessage: OnMessage): void {
    this.onMessage = onMessage;
    if (!this.enabled || !this.bot || this.running) return;

    this.running = true;
    this.startPromise = this.bot.start().catch((error) => {
      if (this.running) {
        log.error(`Discord: gateway error (${this.adapterId})`, error);
      }
    }).finally(() => {
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    const startPromise = this.startPromise;
    this.startPromise = undefined;
    if (this.bot && this.running) {
      this.running = false;
      await this.bot.shutdown();
    }
    if (startPromise) {
      await startPromise;
    }
  }

  async send(message: OutboundChannelMessage): Promise<void> {
    if (!this.bot) {
      log.warn(`Discord: bot is not initialized for ${this.adapterId}`);
      return;
    }

    const channelId = message.address.threadId ?? message.address.roomId ??
      message.address.userId;
    if (!channelId) {
      log.warn("Discord: missing roomId/threadId/userId in outbound address");
      return;
    }

    try {
      await this.bot.helpers.sendMessage(channelId, {
        content: message.content,
      });
    } catch (error) {
      log.error(`Discord: send error (${this.adapterId})`, error);
    }
  }

  isConnected(): boolean {
    return this.running;
  }

  private async handleMessageCreate(
    message: DiscordGatewayMessage,
  ): Promise<void> {
    const channelMessage = await this.createChannelMessage(message);
    if (!channelMessage) return;
    await this.onMessage?.(channelMessage);
  }

  private async createChannelMessage(
    message: DiscordGatewayMessage,
  ): Promise<ChannelMessage | null> {
    const content = typeof message.content === "string"
      ? message.content.trim()
      : "";
    if (content.length === 0 || !message.author) return null;

    const userId = stringifySnowflake(message.author.id);
    if (!userId) return null;
    if (message.author.bot) {
      if (this.botUserId && userId === this.botUserId) return null;
      return null;
    }
    if (!this.isAuthorized(userId, this.config.allowFrom)) return null;

    const channelId = stringifySnowflake(message.channelId);
    if (!channelId) return null;
    const scope = await this.resolveMessageScope(channelId);
    const messageId = stringifySnowflake(message.id);
    const guildId = stringifySnowflake(message.guildId);

    return {
      id: generateId(),
      sessionId: buildDiscordSessionId(
        this.accountId,
        scope.threadId ?? scope.roomId,
      ),
      userId,
      content,
      channelType: "discord",
      timestamp: normalizeDiscordTimestamp(message.timestamp),
      address: {
        channelType: "discord",
        ...(this.accountId ? { accountId: this.accountId } : {}),
        userId,
        roomId: scope.roomId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
        ...(messageId ? { replyToMessageId: messageId } : {}),
      },
      metadata: {
        ...(messageId ? { messageId } : {}),
        ...(guildId ? { guildId } : {}),
        ...(message.author.username
          ? { username: message.author.username }
          : {}),
        ...(this.accountId ? { botAccountId: this.accountId } : {}),
        ...(this.botUsername ? { botUsername: this.botUsername } : {}),
        ...(this.botUserId ? { botUserId: this.botUserId } : {}),
      },
    };
  }

  private async resolveMessageScope(
    channelId: string,
  ): Promise<DiscordResolvedScope> {
    const cached = this.channelScopeCache.get(channelId);
    if (cached) return cached;

    const fallback = { roomId: channelId };
    if (!this.bot) return fallback;

    try {
      const channel = await this.bot.helpers.getChannel(channelId);
      const resolved = isDiscordThreadChannel(channel) && channel.parentId
        ? {
          roomId: channel.parentId.toString(),
          threadId: channel.id.toString(),
        }
        : fallback;
      this.channelScopeCache.set(channelId, resolved);
      return resolved;
    } catch (error) {
      log.warn(
        `Discord: failed to resolve channel scope (${this.adapterId})`,
        error,
      );
      return fallback;
    }
  }
}

export interface DiscordChannelConfig {
  enabled: boolean;
  adapterId: string;
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
}

export function resolveDiscordChannelConfigs(
  config?: DiscordConfig,
): DiscordChannelConfig[] {
  if (!config?.enabled) return [];

  const normalized: DiscordChannelConfig[] = [];
  const seenAccountIds = new Set<string>();

  for (const account of config.accounts ?? []) {
    const accountId = normalizeAccountId(account.accountId);
    if (!accountId) {
      throw new ConfigError(
        "CHANNEL_CONFIG_INVALID",
        {
          channelType: "discord",
          account,
        },
        "Set a non-empty Discord accountId for each configured bot",
      );
    }
    if (seenAccountIds.has(accountId)) {
      throw new ConfigError(
        "CHANNEL_CONFIG_INVALID",
        {
          channelType: "discord",
          accountId,
        },
        "Use a unique Discord accountId for each configured bot",
      );
    }
    seenAccountIds.add(accountId);

    normalized.push({
      enabled: true,
      adapterId: buildDiscordAdapterId(accountId),
      accountId,
      ...(account.token ? { token: account.token } : {}),
      ...(account.tokenEnvVar ? { tokenEnvVar: account.tokenEnvVar } : {}),
      ...(account.allowFrom ? { allowFrom: account.allowFrom } : {}),
    });
  }

  return normalized;
}

function createDiscordBotInstance(
  token: string,
  onMessageCreate: (message: unknown) => Promise<void> | void,
  onReady: (payload: DiscordReadyPayload) => void,
) {
  return createBot({
    token,
    intents: DISCORD_GATEWAY_INTENTS,
    desiredProperties: DISCORD_DESIRED_PROPERTIES,
    events: {
      ready: (payload) => {
        onReady(payload as DiscordReadyPayload);
      },
      messageCreate: async (message) => {
        await onMessageCreate(message);
      },
    },
  });
}

function normalizeAccountId(accountId?: string): string | undefined {
  if (typeof accountId !== "string") return undefined;
  const normalized = accountId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildDiscordAdapterId(accountId?: string): string {
  const normalized = normalizeAccountId(accountId);
  return normalized ? `discord:${normalized}` : "discord";
}

function buildDiscordSessionId(
  accountId: string | undefined,
  roomId: string,
): string {
  const scope = normalizeAccountId(accountId) ?? "default";
  return `discord:${scope}:${roomId}`;
}

function resolveDiscordToken(
  config: DiscordChannelConfig,
): string | undefined {
  if (config.token) return config.token;
  if (!config.tokenEnvVar) return undefined;
  const token = Deno.env.get(config.tokenEnvVar);
  return typeof token === "string" && token.trim().length > 0
    ? token.trim()
    : undefined;
}

function stringifySnowflake(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function normalizeDiscordTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

interface DiscordReadyPayload {
  user?: {
    id?: string | bigint;
    username?: string;
  };
}

interface DiscordGatewayMessage {
  id?: string | bigint;
  content?: string;
  channelId?: string | bigint;
  guildId?: string | bigint | null;
  timestamp?: string | number | Date;
  author?: {
    id?: string | bigint;
    username?: string;
    bot?: boolean;
  };
}

function isDiscordThreadChannel(channel: {
  type?: number;
  parentId?: bigint;
  internalThreadMetadata?: unknown;
}): boolean {
  return channel.internalThreadMetadata !== undefined ||
    channel.type === 10 ||
    channel.type === 11 ||
    channel.type === 12;
}
