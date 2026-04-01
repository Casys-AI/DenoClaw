import type { FederationControlHandlerMap } from "../federation/mod.ts";
import type { AgentCard } from "../../messaging/a2a/types.ts";
import type { BrokerMessage } from "../types.ts";
import type { BrokerFederationMessagingDeps } from "./federation_routing_port.ts";

export function createBrokerFederationControlHandlers(
  deps: BrokerFederationMessagingDeps,
): FederationControlHandlerMap {
  const requireNonEmptyString = (
    value: unknown,
    field: string,
    messageType: BrokerMessage["type"],
  ): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Invalid ${messageType} payload: ${field} must be a non-empty string`,
      );
    }
    return value;
  };

  return {
    federation_link_open: async (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      const linkId = requireNonEmptyString(
        payload.linkId,
        "linkId",
        envelope.type,
      );
      const localBrokerId = requireNonEmptyString(
        payload.localBrokerId,
        "localBrokerId",
        envelope.type,
      );
      const remoteBrokerId = requireNonEmptyString(
        payload.remoteBrokerId,
        "remoteBrokerId",
        envelope.type,
      );
      const traceId = requireNonEmptyString(
        payload.traceId,
        "traceId",
        envelope.type,
      );
      const service = await deps.getFederationService();
      await service.openLink({
        linkId,
        localBrokerId,
        remoteBrokerId,
        requestedBy: envelope.from,
        traceId,
      });

      await deps.sendReply({
        id: envelope.id,
        from: "broker",
        to: envelope.from,
        type: "federation_link_ack",
        payload: {
          linkId,
          remoteBrokerId,
          accepted: true,
          traceId,
        },
        timestamp: new Date().toISOString(),
      });
    },
    federation_link_ack: async (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      const linkId = requireNonEmptyString(
        payload.linkId,
        "linkId",
        envelope.type,
      );
      const remoteBrokerId = requireNonEmptyString(
        payload.remoteBrokerId,
        "remoteBrokerId",
        envelope.type,
      );
      const traceId = requireNonEmptyString(
        payload.traceId,
        "traceId",
        envelope.type,
      );
      if (typeof payload.accepted !== "boolean") {
        throw new Error(
          `Invalid ${envelope.type} payload: accepted must be a boolean`,
        );
      }
      const service = await deps.getFederationService();
      await service.acknowledgeLink(
        {
          linkId,
          remoteBrokerId,
          traceId,
        },
        payload.accepted,
      );
    },
    federation_catalog_sync: async (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      const remoteBrokerId = requireNonEmptyString(
        payload.remoteBrokerId,
        "remoteBrokerId",
        envelope.type,
      );
      const traceId = requireNonEmptyString(
        payload.traceId,
        "traceId",
        envelope.type,
      );
      if (!Array.isArray(payload.agents)) {
        throw new Error(
          `Invalid ${envelope.type} payload: agents must be an array`,
        );
      }
      const entries = payload.agents.map(
        (agent: unknown): { agentId: string; card: AgentCard | null } => {
          if (typeof agent === "string") {
            return { agentId: agent, card: null };
          }
          if (
            agent !== null && typeof agent === "object" &&
            "agentId" in agent && typeof (agent as Record<string, unknown>).agentId === "string"
          ) {
            const entry = agent as { agentId: string; card?: AgentCard };
            return { agentId: entry.agentId, card: entry.card ?? null };
          }
          throw new Error(
            `Invalid ${envelope.type} payload: each agent entry must be a string or { agentId, card? }`,
          );
        },
      );
      const service = await deps.getFederationService();
      await service.syncCatalog(
        remoteBrokerId,
        entries.map(({ agentId, card }) => ({
          remoteBrokerId,
          agentId,
          card,
          capabilities: [],
          visibility: "public",
        })),
        {
          remoteBrokerId,
          traceId,
        },
      );
    },
    federation_route_probe: async (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      const remoteBrokerId = requireNonEmptyString(
        payload.remoteBrokerId,
        "remoteBrokerId",
        envelope.type,
      );
      const targetAgent = requireNonEmptyString(
        payload.targetAgent,
        "targetAgent",
        envelope.type,
      );
      const taskId = requireNonEmptyString(
        payload.taskId,
        "taskId",
        envelope.type,
      );
      const contextId = requireNonEmptyString(
        payload.contextId,
        "contextId",
        envelope.type,
      );
      const traceId = requireNonEmptyString(
        payload.traceId,
        "traceId",
        envelope.type,
      );

      const service = await deps.getFederationService();
      const result = await service.probeRoute({
        requesterBrokerId: envelope.from,
        remoteBrokerId,
        targetAgent,
        taskId,
        contextId,
        traceId,
      });

      await deps.sendReply({
        id: envelope.id,
        from: "broker",
        to: envelope.from,
        type: "federation_link_ack",
        payload: {
          linkId: result.linkId,
          remoteBrokerId,
          accepted: result.accepted,
          traceId,
          reason: result.reason,
        },
        timestamp: new Date().toISOString(),
      });
    },
    federation_link_close: async (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      const linkId = requireNonEmptyString(
        payload.linkId,
        "linkId",
        envelope.type,
      );
      const remoteBrokerId = requireNonEmptyString(
        payload.remoteBrokerId,
        "remoteBrokerId",
        envelope.type,
      );
      const traceId = requireNonEmptyString(
        payload.traceId,
        "traceId",
        envelope.type,
      );
      const service = await deps.getFederationService();
      await service.closeLink({ linkId, remoteBrokerId, traceId });
    },
  };
}
