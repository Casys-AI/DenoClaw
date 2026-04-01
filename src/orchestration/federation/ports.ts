import type { BrokerTaskSubmitPayload } from "../types.ts";
import type { AgentCard } from "../../messaging/a2a/types.ts";
import type {
  BrokerIdentity,
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationBrokerCorrelationContext,
  FederationCorrelationContext,
  FederationDeadLetter,
  FederationDenialDecision,
  FederationDenialKind,
  FederationLink,
  FederationLinkCorrelationContext,
  FederationLinkState,
  FederationSessionToken,
  FederationStatsSnapshot,
  FederationTraceContext,
  RemoteAgentCatalogEntry,
} from "./types.ts";

export interface EstablishFederationLinkInput {
  linkId?: string;
  localBrokerId: string;
  remoteBrokerId: string;
  requestedBy: string;
  correlation: FederationLinkCorrelationContext;
}

export interface FederationControlPort {
  establishLink(input: EstablishFederationLinkInput): Promise<FederationLink>;
  acknowledgeLink(
    linkId: string,
    accepted: boolean,
    correlation: FederationLinkCorrelationContext,
  ): Promise<void>;
  terminateLink(
    linkId: string,
    correlation: FederationLinkCorrelationContext,
  ): Promise<void>;
  setLinkState(
    linkId: string,
    state: FederationLinkState,
    correlation: FederationLinkCorrelationContext,
  ): Promise<void>;
  rotateLinkSession(
    linkId: string,
    correlation: FederationLinkCorrelationContext,
    ttlSeconds?: number,
  ): Promise<FederationSessionToken>;
  listLinks(): Promise<FederationLink[]>;
  refreshTrust(
    remoteBrokerId: string,
    correlation: FederationBrokerCorrelationContext,
  ): Promise<BrokerIdentity>;
}

export interface FederationDiscoveryPort {
  listRemoteAgents(
    remoteBrokerId: string,
    correlation: FederationBrokerCorrelationContext,
  ): Promise<RemoteAgentCatalogEntry[]>;
  setRemoteCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
    correlation: FederationBrokerCorrelationContext,
  ): Promise<void>;
  getRemoteAgentCard(
    remoteBrokerId: string,
    agentId: string,
    correlation: FederationBrokerCorrelationContext,
  ): Promise<AgentCard | null>;
}

export interface FederationIdentityPort {
  upsertIdentity(
    identity: BrokerIdentity,
    correlation?: FederationTraceContext,
  ): Promise<void>;
  getIdentity(
    brokerId: string,
    correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity | null>;
  listIdentities(
    correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity[]>;
  revokeIdentity(
    brokerId: string,
    correlation?: FederationTraceContext,
  ): Promise<void>;
  rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
    correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity>;
}

export interface FederationPolicyPort {
  setRoutePolicy(
    brokerId: string,
    policy: FederatedRoutePolicy,
    correlation: FederationBrokerCorrelationContext,
  ): Promise<void>;
  getRoutePolicy(
    brokerId: string,
    correlation: FederationBrokerCorrelationContext,
  ): Promise<FederatedRoutePolicy | null>;
}

export interface FederationRoutingPort {
  resolveTarget(
    task: BrokerTaskSubmitPayload,
    policy: FederatedRoutePolicy,
    correlation: FederationCorrelationContext,
  ): Promise<{
    kind: "local" | "remote";
    remoteBrokerId?: string;
    reason: string;
  }>;
  forwardTask(
    task: BrokerTaskSubmitPayload,
    remoteBrokerId: string,
    correlation: FederationCorrelationContext,
  ): Promise<void>;
}

export interface FederationDeliveryPort {
  createSubmissionRecord(
    record: FederatedSubmissionRecord,
    correlation: FederationCorrelationContext,
  ): Promise<boolean>;
  getSubmissionRecord(
    idempotencyKey: string,
    correlation: FederationCorrelationContext,
  ): Promise<FederatedSubmissionRecord | null>;
  upsertSubmissionRecord(
    record: FederatedSubmissionRecord,
    correlation: FederationCorrelationContext,
  ): Promise<void>;
  moveToDeadLetter(
    entry: FederationDeadLetter,
    correlation: FederationCorrelationContext,
  ): Promise<void>;
  deleteSubmissionRecord(
    idempotencyKey: string,
    correlation: FederationCorrelationContext,
  ): Promise<void>;
  getDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<FederationDeadLetter | null>;
  claimDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<FederationDeadLetter | null>;
  deleteDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<void>;
  listDeadLetters(remoteBrokerId?: string): Promise<FederationDeadLetter[]>;
}

export interface FederationMetricsPort {
  getFederationStats(remoteBrokerId?: string): Promise<FederationStatsSnapshot>;
}

export interface CrossBrokerHopEvent extends FederationCorrelationContext {
  linkId: string;
  remoteBrokerId: string;
  taskId: string;
  latencyMs: number;
  success: boolean;
  errorKind?: "delivery" | "auth";
  errorCode?: string;
  occurredAt: string;
}

export interface FederationDenialEvent extends FederationCorrelationContext {
  kind: FederationDenialKind;
  decision: FederationDenialDecision;
  errorCode?: string;
  occurredAt: string;
}

export type FederationEvent = CrossBrokerHopEvent | FederationDenialEvent;

export interface FederationObservabilityPort {
  recordCrossBrokerHop(event: CrossBrokerHopEvent): Promise<void>;
  recordFederationDenial(event: FederationDenialEvent): Promise<void>;
  streamFederationEvents(
    onEvent: (event: FederationEvent) => void,
  ): Promise<() => void>;
}
