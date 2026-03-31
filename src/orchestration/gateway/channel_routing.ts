import { getExplicitChannelMessageAgentId } from "../channel_ingress/direct_route.ts";
import type { ChannelMessage, ChannelsConfig } from "../../messaging/types.ts";
import {
  type ChannelRoutePlan,
  createDirectChannelRoutePlan,
} from "../channel_routing/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { resolveConfiguredChannelRoutePlan } from "../channel_routing/policy.ts";

export function resolveGatewayChannelRoutePlan(
  message: ChannelMessage,
  agentIds: string[],
  channelsConfig?: ChannelsConfig,
): ChannelRoutePlan {
  const explicitAgentId = getExplicitChannelMessageAgentId(message);
  if (explicitAgentId) {
    return assertAvailableGatewayTargets(
      createDirectChannelRoutePlan(explicitAgentId),
      agentIds,
      message,
    );
  }

  const configuredRoutePlan = resolveConfiguredChannelRoutePlan(
    message,
    channelsConfig,
  );
  if (configuredRoutePlan) {
    return assertAvailableGatewayTargets(
      configuredRoutePlan,
      agentIds,
      message,
    );
  }

  if (agentIds.length === 1) {
    return createDirectChannelRoutePlan(agentIds[0]);
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

function assertAvailableGatewayTargets(
  routePlan: ChannelRoutePlan,
  availableAgentIds: string[],
  message: ChannelMessage,
): ChannelRoutePlan {
  const missingAgentIds = routePlan.targetAgentIds.filter((agentId) =>
    !availableAgentIds.includes(agentId)
  );

  if (missingAgentIds.length > 0) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_TARGET_UNAVAILABLE",
      {
        messageId: message.id,
        channelType: message.channelType,
        targetAgentIds: routePlan.targetAgentIds,
        missingAgentIds,
        availableAgents: availableAgentIds,
      },
      "Start the configured target agents before accepting this channel scope",
    );
  }

  return routePlan;
}
