import type { ChannelMessage } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";
import type {
  DirectChannelIngressRoute,
  DirectChannelIngressRouteInput,
} from "./types.ts";

export function getExplicitChannelMessageAgentId(
  message: ChannelMessage,
): string | undefined {
  const value = message.metadata?.agentId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function requireDirectChannelIngressRoute(
  message: ChannelMessage,
  route?: DirectChannelIngressRouteInput,
): DirectChannelIngressRoute {
  const agentId = normalizeNonEmptyString(route?.agentId) ??
    getExplicitChannelMessageAgentId(message);

  if (!agentId) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_MISSING",
      {
        messageId: message.id,
        channelType: message.channelType,
      },
      "Provide a direct ingress target via route.agentId or message.metadata.agentId",
    );
  }

  return {
    agentId,
    ...(route?.contextId ? { contextId: route.contextId } : {}),
    ...(route?.metadata ? { metadata: route.metadata } : {}),
  };
}

export function requireDirectChannelIngressRouteFromPlan(
  message: ChannelMessage,
  plan?: ChannelRoutePlan,
): DirectChannelIngressRoute {
  if (!plan) {
    return requireDirectChannelIngressRoute(message);
  }

  if (plan.delivery !== "direct") {
    throw new DenoClawError(
      "CHANNEL_DELIVERY_UNSUPPORTED",
      {
        messageId: message.id,
        channelType: message.channelType,
        delivery: plan.delivery,
        targetAgentIds: plan.targetAgentIds,
      },
      "Current channel ingress execution supports only direct delivery; shared delivery needs a dedicated runtime path",
    );
  }

  if (plan.targetAgentIds.length !== 1) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_INVALID",
      {
        messageId: message.id,
        channelType: message.channelType,
        targetAgentIds: plan.targetAgentIds,
        primaryAgentId: plan.primaryAgentId,
      },
      "Direct delivery requires exactly one target agent",
    );
  }

  const agentId = normalizeNonEmptyString(plan.primaryAgentId) ??
    normalizeNonEmptyString(plan.targetAgentIds[0]);
  if (!agentId) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_INVALID",
      {
        messageId: message.id,
        channelType: message.channelType,
        targetAgentIds: plan.targetAgentIds,
        primaryAgentId: plan.primaryAgentId,
      },
      "Direct delivery requires a non-empty target agent",
    );
  }

  return {
    agentId,
    ...(plan.contextId ? { contextId: plan.contextId } : {}),
    ...(plan.metadata ? { metadata: plan.metadata } : {}),
  };
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
