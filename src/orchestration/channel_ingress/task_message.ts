import type { A2AMessage } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";

export function createChannelTaskMessage(message: ChannelMessage): A2AMessage {
  return {
    messageId: message.id,
    role: "user",
    parts: [{ kind: "text", text: message.content }],
    metadata: {
      channel: {
        channelType: message.channelType,
        sessionId: message.sessionId,
        userId: message.userId,
        address: message.address,
        timestamp: message.timestamp,
      },
      ...(message.metadata ? { channelMessage: message.metadata } : {}),
    },
  };
}
