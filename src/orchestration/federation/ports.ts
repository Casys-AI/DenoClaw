import type { BrokerTaskSubmitPayload } from "../types.ts";
import type {
  BrokerIdentity,
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationDeadLetter,
  FederationLink,
  FederationLinkState,
  FederationSessionToken,
  FederationStatsSnapshot,
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
  rotateLinkSession(
    linkId: string,
    ttlSeconds?: number,
  ): Promise<FederationSessionToken>;
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
  rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
  ): Promise<BrokerIdentity>;
}

export interface FederationPolicyPort {
  setRoutePolicy(brokerId: string, policy: FederatedRoutePolicy): Promise<void>;
  getRoutePolicy(brokerId: string): Promise<FederatedRoutePolicy | null>;
}

export interface FederationRoutingPort {
  resolveTarget(
    task: BrokerTaskSubmitPayload,
    policy: FederatedRoutePolicy,
  ): Promise<{
    kind: "local" | "remote";
    remoteBrokerId?: string;
    reason: string;
  }>;
  forwardTask(
    task: BrokerTaskSubmitPayload,
    remoteBrokerId: string,
  ): Promise<void>;
}

export interface FederationDeliveryPort {
  createSubmissionRecord(record: FederatedSubmissionRecord): Promise<boolean>;
  getSubmissionRecord(
    idempotencyKey: string,
  ): Promise<FederatedSubmissionRecord | null>;
  upsertSubmissionRecord(record: FederatedSubmissionRecord): Promise<void>;
  moveToDeadLetter(entry: FederationDeadLetter): Promise<void>;
  listDeadLetters(remoteBrokerId?: string): Promise<FederationDeadLetter[]>;
}

export interface FederationMetricsPort {
  getFederationStats(remoteBrokerId?: string): Promise<FederationStatsSnapshot>;
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
