import type {
  FederationControlPort,
  FederationDiscoveryPort,
  FederationPolicyPort,
} from "./ports.ts";
import type {
  FederatedRoutePolicy,
  FederationLink,
  RemoteAgentCatalogEntry,
} from "./types.ts";

export interface FederationLinkOpenInput {
  linkId: string;
  localBrokerId: string;
  remoteBrokerId: string;
  requestedBy: string;
}

export interface FederationRouteProbeInput {
  requesterBrokerId: string;
  remoteBrokerId: string;
  targetAgent: string;
}

export interface FederationRouteProbeResult {
  linkId: string;
  accepted: boolean;
  reason:
    | "route_available"
    | "denied_by_policy"
    | "outside_allow_list"
    | "target_agent_not_found";
}

const DEFAULT_POLICY: FederatedRoutePolicy = {
  policyId: "default",
  preferLocal: false,
  preferredRemoteBrokerIds: [],
  denyAgentIds: [],
};

export class FederationService {
  constructor(
    private readonly control: FederationControlPort,
    private readonly discovery: FederationDiscoveryPort,
    private readonly policy: FederationPolicyPort,
  ) {}

  async openLink(input: FederationLinkOpenInput): Promise<FederationLink> {
    return await this.control.establishLink({
      linkId: input.linkId,
      localBrokerId: input.localBrokerId,
      remoteBrokerId: input.remoteBrokerId,
      requestedBy: input.requestedBy,
    });
  }

  async acknowledgeLink(linkId: string, accepted: boolean): Promise<void> {
    await this.control.acknowledgeLink(linkId, accepted);
  }

  async syncCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
  ): Promise<void> {
    await this.discovery.setRemoteCatalog(remoteBrokerId, entries);
  }

  async closeLink(linkId: string): Promise<void> {
    await this.control.terminateLink(linkId);
  }

  async probeRoute(
    input: FederationRouteProbeInput,
  ): Promise<FederationRouteProbeResult> {
    const requesterPolicy =
      await this.policy.getRoutePolicy(input.requesterBrokerId) ??
        DEFAULT_POLICY;
    const remotePolicy = await this.policy.getRoutePolicy(input.remoteBrokerId);

    const deniedByRequester = requesterPolicy.denyAgentIds.includes(
      input.targetAgent,
    );
    const deniedByRemote =
      remotePolicy?.denyAgentIds.includes(input.targetAgent) ??
        false;
    const deniedByPolicy = deniedByRequester || deniedByRemote;

    const outsideRequesterAllowList =
      Array.isArray(requesterPolicy.allowAgentIds) &&
      requesterPolicy.allowAgentIds.length > 0 &&
      !requesterPolicy.allowAgentIds.includes(input.targetAgent);
    const outsideRemoteAllowList = Array.isArray(remotePolicy?.allowAgentIds) &&
      remotePolicy.allowAgentIds.length > 0 &&
      !remotePolicy.allowAgentIds.includes(input.targetAgent);
    const outsideAllowList = outsideRequesterAllowList ||
      outsideRemoteAllowList;

    const catalog = await this.discovery.listRemoteAgents(input.remoteBrokerId);
    const available = catalog.some((entry) =>
      entry.agentId === input.targetAgent
    );
    const accepted = !deniedByPolicy && !outsideAllowList && available;

    return {
      linkId: `${input.requesterBrokerId}:${input.remoteBrokerId}`,
      accepted,
      reason: deniedByPolicy
        ? "denied_by_policy"
        : outsideAllowList
        ? "outside_allow_list"
        : available
        ? "route_available"
        : "target_agent_not_found",
    };
  }
}
