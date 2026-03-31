import type { ChannelAddress } from "../../messaging/types.ts";

export type ChannelDeliveryMode = "direct" | "broadcast";

export type ChannelOrchestrationStrategy = "front-agent" | "by-intent";

export interface ChannelIngressScope {
  channelType: string;
  accountId?: string;
  roomId?: string;
  threadId?: string;
}

export interface ChannelRoutePlan {
  delivery: ChannelDeliveryMode;
  targetAgentIds: string[];
  primaryAgentId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export function createDirectChannelRoutePlan(
  agentId: string,
  options: {
    contextId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): ChannelRoutePlan {
  return {
    delivery: "direct",
    targetAgentIds: [agentId],
    primaryAgentId: agentId,
    ...(options.contextId ? { contextId: options.contextId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function createBroadcastChannelRoutePlan(
  agentIds: string[],
  options: {
    contextId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): ChannelRoutePlan {
  return {
    delivery: "broadcast",
    targetAgentIds: [...agentIds],
    ...(options.contextId ? { contextId: options.contextId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export interface ChannelSubscriberBinding {
  agentId: string;
  canReply?: boolean;
}

export interface ChannelIngressPolicy {
  scope: ChannelIngressScope;
  delivery: ChannelDeliveryMode;
  subscribers: ChannelSubscriberBinding[];
  defaultAgentId?: string;
  orchestration?: ChannelOrchestrationStrategy;
}

export function toChannelIngressScope(
  address: ChannelAddress,
): ChannelIngressScope {
  return {
    channelType: address.channelType,
    ...(address.accountId ? { accountId: address.accountId } : {}),
    ...(address.roomId ? { roomId: address.roomId } : {}),
    ...(address.threadId ? { threadId: address.threadId } : {}),
  };
}
