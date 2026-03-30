import type { ChannelAddress, ChannelMessage } from "../../messaging/types.ts";

export interface ChannelIngressMessageInput {
  channelType: string;
  sessionId: string;
  userId: string;
  content: string;
  address?: Partial<ChannelAddress>;
  metadata?: Record<string, unknown>;
}

export function createChannelIngressMessage(
  input: ChannelIngressMessageInput,
): ChannelMessage {
  return {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    userId: input.userId,
    content: input.content,
    channelType: input.channelType,
    timestamp: new Date().toISOString(),
    address: {
      channelType: input.channelType,
      userId: input.userId,
      roomId: input.userId,
      ...(input.address ?? {}),
    },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
