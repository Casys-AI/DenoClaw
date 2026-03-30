import { generateId } from "../../shared/helpers.ts";
import {
  type BrokerMessage,
  extractBrokerSubmitTaskMessage,
} from "../types.ts";
import type { FederationRoutingPort } from "../federation/mod.ts";
import type { FederationService } from "../federation/mod.ts";
import type { TunnelConnection } from "./tunnel_registry.ts";

export interface BrokerFederationMessagingDeps {
  findRemoteBrokerConnection(remoteBrokerId: string): TunnelConnection | null;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
  getFederationService(): Promise<FederationService>;
  sendReply(reply: BrokerMessage): Promise<void>;
}

export function createBrokerFederationRoutingPort(
  deps: BrokerFederationMessagingDeps,
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
        return Promise.reject(
          new Error(
            `federation_forward_failed:${remoteBrokerId}:remote_broker_unavailable`,
          ),
        );
      }
      const advertisedAgents = remoteTunnel.capabilities.agents ?? [];
      if (
        advertisedAgents.length > 0 &&
        !advertisedAgents.includes(task.targetAgent)
      ) {
        return Promise.reject(
          new Error(
            `federation_forward_failed:${remoteBrokerId}:target_not_advertised`,
          ),
        );
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
        return Promise.reject(
          new Error(
            `federation_forward_failed:${remoteBrokerId}:${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }

      return Promise.resolve();
    },
  };
}
