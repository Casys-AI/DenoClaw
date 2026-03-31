import { DenoClawError } from "../../shared/errors.ts";
import {
  type ChannelRoutePlan,
  createBroadcastChannelRoutePlan,
  createDirectChannelRoutePlan,
} from "../channel_routing/types.ts";

export interface GatewayInteractiveRouteInput {
  agentId?: unknown;
  agentIds?: unknown;
  delivery?: unknown;
  model?: unknown;
}

export function resolveGatewayInteractiveRoutePlan(
  input: GatewayInteractiveRouteInput,
): ChannelRoutePlan {
  const metadata =
    typeof input.model === "string" && input.model.trim().length > 0
      ? { model: input.model }
      : undefined;

  const agentId = normalizeNonEmptyString(input.agentId);
  const agentIds = normalizeAgentIds(input.agentIds);
  const delivery = normalizeDelivery(input.delivery);

  if (agentId && agentIds.length > 0) {
    throw new DenoClawError(
      "INVALID_INPUT",
      {
        fields: ["agentId", "agentIds"],
      },
      "Provide either 'agentId' for direct delivery or 'agentIds' for shared delivery, not both",
    );
  }

  if (agentId) {
    if (delivery && delivery !== "direct") {
      throw new DenoClawError(
        "INVALID_INPUT",
        {
          field: "delivery",
          expected: "direct",
          actual: delivery,
        },
        "Use delivery='direct' with 'agentId', or use 'agentIds' for shared delivery",
      );
    }

    return createDirectChannelRoutePlan(
      agentId,
      metadata ? { metadata } : {},
    );
  }

  if (agentIds.length > 0) {
    if (delivery && delivery !== "broadcast") {
      throw new DenoClawError(
        "INVALID_INPUT",
        {
          field: "delivery",
          expected: "broadcast",
          actual: delivery,
        },
        "Use delivery='broadcast' with 'agentIds'",
      );
    }

    return createBroadcastChannelRoutePlan(
      agentIds,
      metadata ? { metadata } : {},
    );
  }

  throw new DenoClawError(
    "INVALID_INPUT",
    {
      fields: ["agentId", "agentIds"],
    },
    "Provide 'agentId' for direct delivery or 'agentIds' for shared delivery",
  );
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function normalizeDelivery(
  value: unknown,
): "direct" | "broadcast" | undefined {
  return value === "direct" || value === "broadcast" ? value : undefined;
}
