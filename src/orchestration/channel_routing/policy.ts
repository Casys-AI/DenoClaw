import type {
  ChannelMessage,
  ChannelRouteScopeConfig,
  ChannelsConfig,
} from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import {
  type ChannelRoutePlan,
  createBroadcastChannelRoutePlan,
  createDirectChannelRoutePlan,
  toChannelIngressScope,
} from "./types.ts";

export function resolveConfiguredChannelRoutePlan(
  message: ChannelMessage,
  channelsConfig?: ChannelsConfig,
): ChannelRoutePlan | null {
  const scopes = channelsConfig?.routing?.scopes ?? [];
  if (scopes.length === 0) return null;

  const matchingScopes = scopes
    .map((policy) => ({
      policy,
      specificity: getPolicySpecificity(policy),
    }))
    .filter(({ policy }) => matchesChannelRouteScope(message, policy));

  if (matchingScopes.length === 0) return null;

  matchingScopes.sort((left, right) => right.specificity - left.specificity);
  const [selected, next] = matchingScopes;
  if (next && next.specificity === selected.specificity) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_AMBIGUOUS",
      {
        messageId: message.id,
        channelType: message.channelType,
        scope: toChannelIngressScope(message.address),
        matchingPolicies: matchingScopes
          .filter((entry) => entry.specificity === selected.specificity)
          .map((entry) => entry.policy.scope),
      },
      "Make channel routing scopes more specific so exactly one ingress policy matches",
    );
  }

  return createChannelRoutePlanFromScopeConfig(selected.policy);
}

function matchesChannelRouteScope(
  message: ChannelMessage,
  policy: ChannelRouteScopeConfig,
): boolean {
  const scope = policy.scope;
  if (scope.channelType !== message.channelType) return false;
  if (scope.accountId && scope.accountId !== message.address.accountId) {
    return false;
  }
  if (scope.roomId && scope.roomId !== message.address.roomId) {
    return false;
  }
  if (scope.threadId && scope.threadId !== message.address.threadId) {
    return false;
  }
  return true;
}

function getPolicySpecificity(policy: ChannelRouteScopeConfig): number {
  let score = 1; // channelType always participates
  if (policy.scope.accountId) score += 1;
  if (policy.scope.roomId) score += 1;
  if (policy.scope.threadId) score += 1;
  return score;
}

function createChannelRoutePlanFromScopeConfig(
  policy: ChannelRouteScopeConfig,
): ChannelRoutePlan {
  const targetAgentIds = normalizeTargetAgentIds(policy.targetAgentIds);
  if (policy.delivery === "direct") {
    if (targetAgentIds.length !== 1) {
      throw new DenoClawError(
        "CHANNEL_ROUTE_INVALID",
        {
          scope: policy.scope,
          delivery: policy.delivery,
          targetAgentIds: policy.targetAgentIds,
        },
        "Direct channel routing scope requires exactly one target agent",
      );
    }
    return createDirectChannelRoutePlan(targetAgentIds[0], {
      ...(policy.metadata ? { metadata: policy.metadata } : {}),
    });
  }

  return createBroadcastChannelRoutePlan(targetAgentIds, {
    ...(policy.metadata ? { metadata: policy.metadata } : {}),
  });
}

function normalizeTargetAgentIds(targetAgentIds: string[]): string[] {
  const normalized = [
    ...new Set(
      targetAgentIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];

  if (normalized.length === 0) {
    throw new DenoClawError(
      "CHANNEL_ROUTE_INVALID",
      { targetAgentIds },
      "Channel routing scope requires at least one target agent",
    );
  }

  return normalized;
}
