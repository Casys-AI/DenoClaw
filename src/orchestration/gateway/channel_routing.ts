import type { ChannelRouteHint } from "../channel_ingress/mod.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";

export function resolveGatewayChannelRoute(
  message: ChannelMessage,
  agentIds: string[],
): ChannelRouteHint {
  const explicitAgentId = typeof message.metadata?.agentId === "string"
    ? message.metadata.agentId.trim()
    : "";
  if (explicitAgentId) {
    return { agentId: explicitAgentId };
  }

  if (agentIds.length === 1) {
    return { agentId: agentIds[0] };
  }

  throw new DenoClawError(
    "CHANNEL_ROUTE_MISSING",
    {
      messageId: message.id,
      channelType: message.channelType,
      availableAgents: agentIds,
    },
    agentIds.length === 0
      ? "Start at least one agent before receiving channel traffic"
      : "Provide an explicit agentId for channel traffic when multiple agents are running",
  );
}
