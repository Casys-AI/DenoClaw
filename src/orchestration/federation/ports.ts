import type { BrokerTaskSubmitPayload } from "../types.ts";
import type {
  BrokerIdentity,
  FederatedRoutePolicy,
  FederationLink,
  FederationLinkState,
  RemoteAgentCatalogEntry,
} from "./types.ts";

export interface EstablishFederationLinkInput {
  linkId?: string;
  localBrokerId: string;
  remoteBrokerId: string;
  requestedBy: string;
}

export interface FederationControlPort {
  establishLink(input: EstablishFederationLinkInput): Promise<FederationLink>;
  acknowledgeLink(linkId: string, accepted: boolean): Promise<void>;
  terminateLink(linkId: string): Promise<void>;
  setLinkState(linkId: string, state: FederationLinkState): Promise<void>;
  listLinks(): Promise<FederationLink[]>;
  refreshTrust(remoteBrokerId: string): Promise<BrokerIdentity>;
}

export interface FederationDiscoveryPort {
  listRemoteAgents(remoteBrokerId: string): Promise<RemoteAgentCatalogEntry[]>;
  setRemoteCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
  ): Promise<void>;
  getRemoteAgentCard(
    remoteBrokerId: string,
    agentId: string,
  ): Promise<Record<string, unknown> | null>;
}

export interface FederationIdentityPort {
  upsertIdentity(identity: BrokerIdentity): Promise<void>;
  getIdentity(brokerId: string): Promise<BrokerIdentity | null>;
  listIdentities(): Promise<BrokerIdentity[]>;
  revokeIdentity(brokerId: string): Promise<void>;
}

export interface FederationPolicyPort {
  setRoutePolicy(
    brokerId: string,
    policy: FederatedRoutePolicy,
  ): Promise<void>;
  getRoutePolicy(brokerId: string): Promise<FederatedRoutePolicy | null>;
}

export interface FederationRoutingPort {
  resolveTarget(
    task: BrokerTaskSubmitPayload,
    policy: FederatedRoutePolicy,
  ): Promise<
    { kind: "local" | "remote"; remoteBrokerId?: string; reason: string }
  >;
  forwardTask(
    task: BrokerTaskSubmitPayload,
    remoteBrokerId: string,
  ): Promise<void>;
}

export interface CrossBrokerHopEvent {
  linkId: string;
  remoteBrokerId: string;
  taskId: string;
  contextId?: string;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  occurredAt: string;
}

export interface FederationObservabilityPort {
  recordCrossBrokerHop(event: CrossBrokerHopEvent): Promise<void>;
  streamFederationEvents(
    onEvent: (event: CrossBrokerHopEvent) => void,
  ): Promise<() => void>;
}
