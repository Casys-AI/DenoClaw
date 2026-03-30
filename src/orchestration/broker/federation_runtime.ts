import { generateId } from "../../shared/helpers.ts";
import { DenoClawError } from "../../shared/errors.ts";
import {
  type BrokerFederationMessage,
  type BrokerMessage,
  extractBrokerSubmitTaskMessage,
} from "../types.ts";
import type {
  FederationControlEnvelope,
  FederationControlHandlerMap,
  FederationRoutingPort,
  FederationService,
} from "../federation/mod.ts";
import { isFederationControlMethod } from "../federation/mod.ts";
import type { TunnelConnection } from "./tunnel_registry.ts";

export interface BrokerFederationRuntimeDeps {
  findRemoteBrokerConnection(remoteBrokerId: string): TunnelConnection | null;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
  getFederationService(): Promise<FederationService>;
  sendReply(reply: BrokerMessage): Promise<void>;
}

export function createBrokerFederationRoutingPort(
  deps: BrokerFederationRuntimeDeps,
): FederationRoutingPort {
  return {
    resolveTarget: (task, _policy, correlation) => {
      const tunnel = deps.findRemoteBrokerConnection(
        correlation.remoteBrokerId,
      );
      const advertisedAgents = tunnel?.capabilities.agents ?? [];
      if (!tunnel) {
        return Promise.resolve({
          kind: "remote",
          remoteBrokerId: correlation.remoteBrokerId,
          reason: "remote_broker_unavailable",
        });
      }
      if (
        advertisedAgents.length > 0 &&
        !advertisedAgents.includes(task.targetAgent)
      ) {
        return Promise.resolve({
          kind: "remote",
          remoteBrokerId: correlation.remoteBrokerId,
          reason: "target_not_advertised_by_remote_broker",
        });
      }
      return Promise.resolve({
        kind: "remote",
        remoteBrokerId: correlation.remoteBrokerId,
        reason: "federation_task_submit",
      });
    },
    forwardTask: (task, remoteBrokerId, correlation) => {
      const taskMessage = extractBrokerSubmitTaskMessage(task);
      const localBrokerId = correlation.linkId.split(":")[0] || "broker";
      const remoteTunnel = deps.findRemoteBrokerConnection(remoteBrokerId);
      if (!remoteTunnel) {
        return Promise.reject(new Error(
          `federation_forward_failed:${remoteBrokerId}:remote_broker_unavailable`,
        ));
      }
      const advertisedAgents = remoteTunnel.capabilities.agents ?? [];
      if (
        advertisedAgents.length > 0 &&
        !advertisedAgents.includes(task.targetAgent)
      ) {
        return Promise.reject(new Error(
          `federation_forward_failed:${remoteBrokerId}:target_not_advertised`,
        ));
      }
      try {
        deps.routeToTunnel(remoteTunnel.ws, {
          id: generateId(),
          from: localBrokerId,
          to: task.targetAgent,
          type: "task_submit",
          payload: {
            ...task,
            taskId: correlation.taskId,
            contextId: correlation.contextId,
            taskMessage,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        return Promise.reject(new Error(
          `federation_forward_failed:${remoteBrokerId}:${
            error instanceof Error ? error.message : String(error)
          }`,
        ));
      }

      return Promise.resolve();
    },
  };
}

export function createBrokerFederationControlHandlers(
  deps: BrokerFederationRuntimeDeps,
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
      const agents = Array.isArray(payload.agents)
        ? payload.agents.filter((agent): agent is string =>
          typeof agent === "string"
        )
        : null;
      if (!agents) {
        throw new Error(
          `Invalid ${envelope.type} payload: agents must be a string[]`,
        );
      }
      const service = await deps.getFederationService();
      await service.syncCatalog(
        remoteBrokerId,
        agents.map((agentId) => ({
          remoteBrokerId,
          agentId,
          card: {},
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

export async function handleBrokerFederationControlMessage(
  router: (envelope: FederationControlEnvelope) => Promise<void>,
  msg: BrokerFederationMessage,
): Promise<void> {
  if (!isFederationControlMethod(msg.type)) {
    throw new DenoClawError(
      "FEDERATION_METHOD_INVALID",
      { type: msg.type },
      "Use federation control-plane method names",
    );
  }
  await router({
    id: msg.id,
    from: msg.from,
    type: msg.type,
    payload: msg.payload,
    timestamp: msg.timestamp,
  });
}
