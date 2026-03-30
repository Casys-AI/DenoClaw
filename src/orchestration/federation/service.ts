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
import { verifyCatalogEnvelopeSignature } from "./crypto.ts";
import {
  buildBrokerCorrelationContext,
  buildLinkCorrelationContext,
} from "./correlation.ts";
import { FederationObservabilityRecorder } from "./observability_recorder.ts";
import { FederationRouteAuthorizer } from "./route_authorizer.ts";
import {
  FederationTaskForwarder,
} from "./task_forwarder.ts";

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
    const correlation = this.buildBrokerCorrelationContext({
      remoteBrokerId: envelope.remoteBrokerId,
      traceId: crypto.randomUUID(),
    });
    const identity = await this.identity.getIdentity(
      envelope.remoteBrokerId,
      { traceId: correlation.traceId },
    );
    if (!identity || identity.status !== "trusted") {
      throw new Error(
        `Federation identity is not trusted for broker ${envelope.remoteBrokerId}`,
      );
    }

    const signatureValid = await verifyCatalogEnvelopeSignature(
      envelope,
      identity.publicKeys,
    );
    if (!signatureValid) {
      throw new Error(
        `Invalid catalog signature for broker ${envelope.remoteBrokerId}`,
      );
    }

    await this.discovery.setRemoteCatalog(
      envelope.remoteBrokerId,
      envelope.entries,
      correlation,
    );
  }

  async closeLink(correlation: FederationLinkCorrelationContext): Promise<void> {
    await this.control.terminateLink(
      correlation.linkId,
      this.buildLinkCorrelationContext(correlation),
    );
  }

  async upsertIdentity(identity: BrokerIdentity): Promise<void> {
    await this.identity.upsertIdentity(identity, { traceId: crypto.randomUUID() });
  }

  async revokeIdentity(brokerId: string): Promise<void> {
    await this.identity.revokeIdentity(brokerId, { traceId: crypto.randomUUID() });
  }

  async rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
  ): Promise<BrokerIdentity> {
    return await this.identity.rotateIdentityKey(
      brokerId,
      nextPublicKey,
      { traceId: crypto.randomUUID() },
    );
  }

  async getIdentity(brokerId: string): Promise<BrokerIdentity | null> {
    return await this.identity.getIdentity(brokerId, {
      traceId: crypto.randomUUID(),
    });
  }

  async listIdentities(): Promise<BrokerIdentity[]> {
    return await this.identity.listIdentities({ traceId: crypto.randomUUID() });
  }

  async replayDeadLetter(
    input: ReplayFederatedDeadLetterInput,
  ): Promise<ForwardFederatedTaskResult> {
    if (!this.taskForwarder) {
      throw new Error(
        "FederationService requires routing and delivery ports for dead-letter replay",
      );
    }
    return await this.taskForwarder.replayDeadLetter(input);
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
    if (!this.taskForwarder) {
      throw new Error(
        "FederationService requires routing and delivery ports for idempotent forwarding",
      );
    }
    return await this.taskForwarder.forwardTaskIdempotent(input);
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
