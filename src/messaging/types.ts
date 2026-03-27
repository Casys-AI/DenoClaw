/**
 * Messaging domain types — extracted from src/types.ts (Phase 4).
 */

export interface Session {
  id: string;
  userId: string;
  channelType: string;
  createdAt: string;
  lastActivity: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelMessage {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  channelType: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface TelegramConfig {
  enabled: boolean;
  token?: string;
  allowFrom?: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  token?: string;
  allowFrom?: string[];
}

export interface WebhookConfig {
  enabled: boolean;
  port?: number;
  secret?: string;
}

export interface ChannelsConfig {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  webhook?: WebhookConfig;
}
