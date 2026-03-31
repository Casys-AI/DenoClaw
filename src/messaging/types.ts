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

export interface ChannelAddress {
  channelType: string;
  accountId?: string;
  roomId?: string;
  threadId?: string;
  userId?: string;
  replyToMessageId?: string;
}

export interface InboundChannelMessage {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  channelType: string;
  timestamp: string;
  address: ChannelAddress;
  metadata?: Record<string, unknown>;
}

export interface OutboundChannelMessage {
  address: ChannelAddress;
  content: string;
  metadata?: Record<string, unknown>;
}

export type ChannelMessage = InboundChannelMessage;

export interface TelegramAccountConfig {
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
}

export interface TelegramConfig {
  enabled: boolean;
  accounts?: TelegramAccountConfig[];
}

export interface DiscordAccountConfig {
  accountId: string;
  token?: string;
  tokenEnvVar?: string;
  allowFrom?: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  accounts?: DiscordAccountConfig[];
}

export interface WebhookConfig {
  enabled: boolean;
  port?: number;
  secret?: string;
}

export type ChannelRouteConfigDelivery = "direct" | "broadcast";

export interface ChannelRouteScopeConfig {
  scope: {
    channelType: string;
    accountId?: string;
    roomId?: string;
    threadId?: string;
  };
  delivery: ChannelRouteConfigDelivery;
  targetAgentIds: string[];
  metadata?: Record<string, unknown>;
}

export interface ChannelRoutingConfig {
  scopes?: ChannelRouteScopeConfig[];
}

export interface ChannelsConfig {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  webhook?: WebhookConfig;
  routing?: ChannelRoutingConfig;
}
