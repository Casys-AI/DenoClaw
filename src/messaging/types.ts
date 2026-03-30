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

export interface TelegramConfig {
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
  webhook?: WebhookConfig;
}
