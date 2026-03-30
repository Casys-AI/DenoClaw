import type {
  FederationControlPort,
  FederationDeliveryPort,
  FederationDiscoveryPort,
  FederationIdentityPort,
  FederationObservabilityPort,
  FederationPolicyPort,
  FederationRoutingPort,
} from "./ports.ts";
import type { BrokerTaskSubmitPayload } from "../types.ts";
import type {
  BrokerIdentity,
  FederationAuthorizationDecision,
  FederationBrokerCorrelationContext,
  FederationLink,
  FederationLinkCorrelationContext,
  FederationSessionToken,
  RemoteAgentCatalogEntry,
  SignedCatalogEnvelope,
} from "./types.ts";
import {
  buildBrokerCorrelationContext,
  buildLinkCorrelationContext,
} from "./correlation.ts";
import { FederationIdentityManager } from "./identity_manager.ts";
import { FederationObservabilityRecorder } from "./observability_recorder.ts";
import { FederationRouteAuthorizer } from "./route_authorizer.ts";
import { FederationTaskForwarder } from "./task_forwarder.ts";

export { FederationDeadLetterNotFoundError } from "./task_forwarder.ts";

export interface FederationLinkOpenInput {
  linkId: string;
  localBrokerId: string;
  remoteBrokerId: string;
  requestedBy: string;
  traceId: string;
}

export interface FederationRouteProbeInput {
  requesterBrokerId: string;
  remoteBrokerId: string;
  targetAgent: string;
  taskId: string;
  contextId: string;
  traceId: string;
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

export interface FederationAuthorizationResult {
  decision: FederationAuthorizationDecision;
  reason:
    | "route_available"
    | "denied_by_local_policy"
    | "denied_by_remote_policy"
    | "target_agent_not_found";
}

export interface ForwardFederatedTaskInput {
  remoteBrokerId: string;
  task: BrokerTaskSubmitPayload & { contextId: string };
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  linkId: string;
  traceId: string;
}

export interface ForwardFederatedTaskResult {
  status: "forwarded" | "deduplicated" | "dead_letter";
  idempotencyKey: string;
  attempts: number;
}

export interface ReplayFederatedDeadLetterInput {
  remoteBrokerId: string;
  deadLetterId: string;
  traceId: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export class FederationService {
  private readonly identityManager: FederationIdentityManager;
  private readonly observabilityRecorder: FederationObservabilityRecorder;
  private readonly routeAuthorizer: FederationRouteAuthorizer;
  private readonly taskForwarder: FederationTaskForwarder | null;

  constructor(
    private readonly control: FederationControlPort,
    private readonly discovery: FederationDiscoveryPort,
    private readonly policy: FederationPolicyPort,
    private readonly identity: FederationIdentityPort,
    private readonly routing?: FederationRoutingPort,
    private readonly delivery?: FederationDeliveryPort,
    private readonly observability?: FederationObservabilityPort,
  ) {
    this.observabilityRecorder = new FederationObservabilityRecorder(
      this.observability ?? null,
    );
    this.identityManager = new FederationIdentityManager({
      discovery: this.discovery,
      identity: this.identity,
    });
    this.routeAuthorizer = new FederationRouteAuthorizer({
      discovery: this.discovery,
      policy: this.policy,
      recorder: this.observabilityRecorder,
    });
    this.taskForwarder = this.routing && this.delivery
      ? new FederationTaskForwarder({
        routing: this.routing,
        delivery: this.delivery,
        recorder: this.observabilityRecorder,
      })
      : null;
  }

  async openLink(input: FederationLinkOpenInput): Promise<FederationLink> {
    return await this.control.establishLink({
      linkId: input.linkId,
      localBrokerId: input.localBrokerId,
      remoteBrokerId: input.remoteBrokerId,
      requestedBy: input.requestedBy,
      correlation: this.buildLinkCorrelationContext({
        linkId: input.linkId,
        remoteBrokerId: input.remoteBrokerId,
        traceId: input.traceId,
      }),
    });
  }

  async acknowledgeLink(
    correlation: FederationLinkCorrelationContext,
    accepted: boolean,
  ): Promise<void> {
    await this.control.acknowledgeLink(
      correlation.linkId,
      accepted,
      this.buildLinkCorrelationContext(correlation),
    );
  }

  async rotateLinkSession(
    correlation: FederationLinkCorrelationContext,
    ttlSeconds?: number,
  ): Promise<FederationSessionToken> {
    if (
      ttlSeconds !== undefined &&
      (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
    ) {
      throw new Error("ttlSeconds must be a positive number");
    }
    return await this.control.rotateLinkSession(
      correlation.linkId,
      this.buildLinkCorrelationContext(correlation),
      ttlSeconds,
    );
  }

  async syncCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
    correlation: FederationBrokerCorrelationContext,
  ): Promise<void> {
    await this.discovery.setRemoteCatalog(
      remoteBrokerId,
      entries,
      this.buildBrokerCorrelationContext(correlation),
    );
  }

  async syncSignedCatalog(envelope: SignedCatalogEnvelope): Promise<void> {
    await this.identityManager.syncSignedCatalog(envelope);
  }

  async closeLink(
    correlation: FederationLinkCorrelationContext,
  ): Promise<void> {
    await this.control.terminateLink(
      correlation.linkId,
      this.buildLinkCorrelationContext(correlation),
    );
  }

  async upsertIdentity(identity: BrokerIdentity): Promise<void> {
    await this.identityManager.upsertIdentity(identity);
  }

  async revokeIdentity(brokerId: string): Promise<void> {
    await this.identityManager.revokeIdentity(brokerId);
  }

  async rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
  ): Promise<BrokerIdentity> {
    return await this.identityManager.rotateIdentityKey(
      brokerId,
      nextPublicKey,
    );
  }

  async getIdentity(brokerId: string): Promise<BrokerIdentity | null> {
    return await this.identityManager.getIdentity(brokerId);
  }

  async listIdentities(): Promise<BrokerIdentity[]> {
    return await this.identityManager.listIdentities();
  }

  async replayDeadLetter(
    input: ReplayFederatedDeadLetterInput,
  ): Promise<ForwardFederatedTaskResult> {
    return await this.requireTaskForwarder(
      "FederationService requires routing and delivery ports for dead-letter replay",
    ).replayDeadLetter(input);
  }

  async probeRoute(
    input: FederationRouteProbeInput,
  ): Promise<FederationRouteProbeResult> {
    return await this.routeAuthorizer.probeRoute(input);
  }

  async evaluateRouteAuthorization(
    input: FederationRouteProbeInput,
  ): Promise<FederationAuthorizationResult> {
    return await this.routeAuthorizer.evaluateRouteAuthorization(input);
  }

  async forwardTaskIdempotent(
    input: ForwardFederatedTaskInput,
  ): Promise<ForwardFederatedTaskResult> {
    return await this.requireTaskForwarder(
      "FederationService requires routing and delivery ports for idempotent forwarding",
    ).forwardTaskIdempotent(input);
  }

  private requireTaskForwarder(message: string): FederationTaskForwarder {
    if (!this.taskForwarder) {
      throw new Error(message);
    }
    return this.taskForwarder;
  }

  private buildBrokerCorrelationContext(
    context: FederationBrokerCorrelationContext,
  ): FederationBrokerCorrelationContext {
    return buildBrokerCorrelationContext(context);
  }

  private buildLinkCorrelationContext(
    context: FederationLinkCorrelationContext,
  ): FederationLinkCorrelationContext {
    return buildLinkCorrelationContext(context);
  }
}
