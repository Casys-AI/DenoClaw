import type { FederationDiscoveryPort, FederationPolicyPort } from "./ports.ts";
import type {
  FederatedRoutePolicy,
  FederationAuthorizationDecision,
} from "./types.ts";
import { buildCorrelationContext } from "./correlation.ts";
import type { FederationObservabilityRecorder } from "./observability_recorder.ts";

const DEFAULT_POLICY: FederatedRoutePolicy = {
  policyId: "default",
  preferLocal: false,
  preferredRemoteBrokerIds: [],
  denyAgentIds: [],
};

interface FederationRouteProbeInputLike {
  requesterBrokerId: string;
  remoteBrokerId: string;
  targetAgent: string;
  taskId: string;
  contextId: string;
  traceId: string;
}

interface FederationAuthorizationResultLike {
  decision: FederationAuthorizationDecision;
  reason:
    | "route_available"
    | "denied_by_local_policy"
    | "denied_by_remote_policy"
    | "target_agent_not_found";
}

interface FederationRouteProbeResultLike {
  linkId: string;
  accepted: boolean;
  reason:
    | "route_available"
    | "denied_by_policy"
    | "outside_allow_list"
    | "target_agent_not_found";
}

export interface FederationRouteAuthorizerDeps {
  discovery: FederationDiscoveryPort;
  policy: FederationPolicyPort;
  recorder: FederationObservabilityRecorder;
}

export class FederationRouteAuthorizer {
  constructor(private readonly deps: FederationRouteAuthorizerDeps) {}

  async probeRoute(
    input: FederationRouteProbeInputLike,
  ): Promise<FederationRouteProbeResultLike> {
    const authorization = await this.evaluateRouteAuthorization(input);
    const accepted = authorization.decision === "ALLOW";

    return {
      linkId: `${input.requesterBrokerId}:${input.remoteBrokerId}`,
      accepted,
      reason: authorization.reason === "denied_by_local_policy" ||
          authorization.reason === "denied_by_remote_policy"
        ? "denied_by_policy"
        : authorization.reason === "route_available"
        ? "route_available"
        : "target_agent_not_found",
    };
  }

  async evaluateRouteAuthorization(
    input: FederationRouteProbeInputLike,
  ): Promise<FederationAuthorizationResultLike> {
    const correlation = buildCorrelationContext({
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.taskId,
      contextId: input.contextId,
      linkId: `${input.requesterBrokerId}:${input.remoteBrokerId}`,
      traceId: input.traceId,
    });
    const requesterPolicy = (await this.deps.policy.getRoutePolicy(
      input.requesterBrokerId,
      correlation,
    )) ?? DEFAULT_POLICY;
    const remotePolicy = await this.deps.policy.getRoutePolicy(
      input.remoteBrokerId,
      correlation,
    );

    if (isAgentDeniedByPolicy(requesterPolicy, input.targetAgent)) {
      await this.deps.recorder.recordDenial(
        correlation,
        "policy",
        "DENY_LOCAL_POLICY",
      );
      return {
        decision: "DENY_LOCAL_POLICY",
        reason: "denied_by_local_policy",
      };
    }

    if (isAgentDeniedByPolicy(remotePolicy, input.targetAgent)) {
      await this.deps.recorder.recordDenial(
        correlation,
        "policy",
        "DENY_REMOTE_POLICY",
      );
      return {
        decision: "DENY_REMOTE_POLICY",
        reason: "denied_by_remote_policy",
      };
    }

    const catalog = await this.deps.discovery.listRemoteAgents(
      input.remoteBrokerId,
      correlation,
    );
    const available = catalog.some(
      (entry) => entry.agentId === input.targetAgent,
    );
    if (!available) {
      await this.deps.recorder.recordDenial(
        correlation,
        "not_found",
        "DENY_REMOTE_NOT_FOUND",
      );
      return {
        decision: "DENY_REMOTE_NOT_FOUND",
        reason: "target_agent_not_found",
      };
    }

    return {
      decision: "ALLOW",
      reason: "route_available",
    };
  }
}

function isAgentDeniedByPolicy(
  policy: FederatedRoutePolicy | null | undefined,
  targetAgent: string,
): boolean {
  if (!policy) return false;
  return policy.denyAgentIds.includes(targetAgent) ||
    (Array.isArray(policy.allowAgentIds) &&
      policy.allowAgentIds.length > 0 &&
      !policy.allowAgentIds.includes(targetAgent));
}
