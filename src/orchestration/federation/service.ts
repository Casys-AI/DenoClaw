import type {
  FederationDeliveryPort,
  FederationControlPort,
  FederationDiscoveryPort,
  FederationIdentityPort,
  FederationObservabilityPort,
  FederationPolicyPort,
  FederationRoutingPort,
} from "./ports.ts";
import type { BrokerTaskSubmitPayload } from "../types.ts";
import type {
  BrokerIdentity,
  FederationCorrelationContext,
  FederationDeadLetter,
  FederationAuthorizationDecision,
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationLink,
  FederationSessionToken,
  RemoteAgentCatalogEntry,
  SignedCatalogEnvelope,
} from "./types.ts";
import { verifyCatalogEnvelopeSignature } from "./crypto.ts";

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
  task: BrokerTaskSubmitPayload;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  linkId?: string;
}

export interface ForwardFederatedTaskResult {
  status: "forwarded" | "deduplicated" | "dead_letter";
  idempotencyKey: string;
  attempts: number;
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
    private readonly identity: FederationIdentityPort,
    private readonly routing?: FederationRoutingPort,
    private readonly delivery?: FederationDeliveryPort,
    private readonly observability?: FederationObservabilityPort,
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

  async rotateLinkSession(
    linkId: string,
    ttlSeconds?: number,
  ): Promise<FederationSessionToken> {
    return await this.control.rotateLinkSession(linkId, ttlSeconds);
  }

  async syncCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
  ): Promise<void> {
    await this.discovery.setRemoteCatalog(remoteBrokerId, entries);
  }

  async syncSignedCatalog(envelope: SignedCatalogEnvelope): Promise<void> {
    const identity = await this.identity.getIdentity(envelope.remoteBrokerId);
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
    );
  }

  async closeLink(linkId: string): Promise<void> {
    await this.control.terminateLink(linkId);
  }

  async upsertIdentity(identity: BrokerIdentity): Promise<void> {
    await this.identity.upsertIdentity(identity);
  }

  async revokeIdentity(brokerId: string): Promise<void> {
    await this.identity.revokeIdentity(brokerId);
  }

  async rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
  ): Promise<BrokerIdentity> {
    return await this.identity.rotateIdentityKey(brokerId, nextPublicKey);
  }

  async getIdentity(brokerId: string): Promise<BrokerIdentity | null> {
    return await this.identity.getIdentity(brokerId);
  }

  async listIdentities(): Promise<BrokerIdentity[]> {
    return await this.identity.listIdentities();
  }

  async probeRoute(
    input: FederationRouteProbeInput,
  ): Promise<FederationRouteProbeResult> {
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
    input: FederationRouteProbeInput,
  ): Promise<FederationAuthorizationResult> {
    const requesterPolicy =
      await this.policy.getRoutePolicy(input.requesterBrokerId) ??
        DEFAULT_POLICY;
    const remotePolicy = await this.policy.getRoutePolicy(input.remoteBrokerId);

    const localDenied = requesterPolicy.denyAgentIds.includes(input.targetAgent) ||
      (Array.isArray(requesterPolicy.allowAgentIds) &&
        requesterPolicy.allowAgentIds.length > 0 &&
        !requesterPolicy.allowAgentIds.includes(input.targetAgent));
    if (localDenied) {
      return {
        decision: "DENY_LOCAL_POLICY",
        reason: "denied_by_local_policy",
      };
    }

    const remoteDenied = (remotePolicy?.denyAgentIds.includes(input.targetAgent) ??
      false) ||
      (Array.isArray(remotePolicy?.allowAgentIds) &&
        (remotePolicy?.allowAgentIds.length ?? 0) > 0 &&
        !remotePolicy?.allowAgentIds.includes(input.targetAgent));
    if (remoteDenied) {
      return {
        decision: "DENY_REMOTE_POLICY",
        reason: "denied_by_remote_policy",
      };
    }

    const catalog = await this.discovery.listRemoteAgents(input.remoteBrokerId);
    const available = catalog.some((entry) =>
      entry.agentId === input.targetAgent
    );
    if (!available) {
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

  async forwardTaskIdempotent(
    input: ForwardFederatedTaskInput,
  ): Promise<ForwardFederatedTaskResult> {
    if (!this.routing || !this.delivery) {
      throw new Error(
        "FederationService requires routing and delivery ports for idempotent forwarding",
      );
    }

    const now = new Date().toISOString();
    const payloadHash = this.computePayloadHash(input.task);
    const idempotencyKey = `${input.remoteBrokerId}:${input.task.taskId}:${payloadHash}`;
    const maxAttempts = input.maxAttempts ?? 3;
    const baseBackoffMs = input.baseBackoffMs ?? 100;
    const maxBackoffMs = input.maxBackoffMs ?? 2_000;

    const existing = await this.delivery.getSubmissionRecord(idempotencyKey);
    if (existing?.status === "completed") {
      return {
        status: "deduplicated",
        idempotencyKey,
        attempts: existing.attempts,
      };
    }

    let record: FederatedSubmissionRecord = existing ?? {
      idempotencyKey,
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.task.taskId,
      payloadHash,
      status: "in_flight",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };

    let lastError = "unknown";
    while (record.attempts < maxAttempts) {
      record = {
        ...record,
        attempts: record.attempts + 1,
        status: "in_flight",
        updatedAt: new Date().toISOString(),
      };
      await this.delivery.upsertSubmissionRecord(record);
      const attemptStartedAt = Date.now();

      try {
        await this.routing.forwardTask(input.task, input.remoteBrokerId);
        const latencyMs = Date.now() - attemptStartedAt;
        await this.recordHop({
          remoteBrokerId: input.remoteBrokerId,
          taskId: input.task.taskId,
          contextId: input.task.contextId,
          linkId: input.linkId,
          latencyMs,
          success: true,
        });
        const completed: FederatedSubmissionRecord = {
          ...record,
          status: "completed",
          updatedAt: new Date().toISOString(),
          resultRef: `${input.remoteBrokerId}:${input.task.taskId}`,
          lastErrorCode: undefined,
        };
        await this.delivery.upsertSubmissionRecord(completed);
        return {
          status: "forwarded",
          idempotencyKey,
          attempts: completed.attempts,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const latencyMs = Date.now() - attemptStartedAt;
        await this.recordHop({
          remoteBrokerId: input.remoteBrokerId,
          taskId: input.task.taskId,
          contextId: input.task.contextId,
          linkId: input.linkId,
          latencyMs,
          success: false,
          errorCode: lastError,
        });
        record = {
          ...record,
          lastErrorCode: lastError,
          updatedAt: new Date().toISOString(),
        };
        await this.delivery.upsertSubmissionRecord(record);
        if (record.attempts < maxAttempts) {
          await this.sleep(this.nextBackoffMs(
            record.attempts,
            baseBackoffMs,
            maxBackoffMs,
          ));
        }
      }
    }

    const deadLetter: FederationDeadLetter = {
      deadLetterId: crypto.randomUUID(),
      idempotencyKey,
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.task.taskId,
      payloadHash,
      reason: `forward_failed_after_${maxAttempts}_attempts:${lastError}`,
      movedAt: new Date().toISOString(),
    };

    await this.delivery.moveToDeadLetter(deadLetter);
    const deadLetterRecord: FederatedSubmissionRecord = {
      ...record,
      status: "dead_letter",
      updatedAt: new Date().toISOString(),
      lastErrorCode: lastError,
    };
    await this.delivery.upsertSubmissionRecord(deadLetterRecord);
    return {
      status: "dead_letter",
      idempotencyKey,
      attempts: deadLetterRecord.attempts,
    };
  }

  private computePayloadHash(task: BrokerTaskSubmitPayload): string {
    return btoa(JSON.stringify(task));
  }

  private nextBackoffMs(
    attempt: number,
    baseBackoffMs: number,
    maxBackoffMs: number,
  ): number {
    const exponential = baseBackoffMs * (2 ** Math.max(0, attempt - 1));
    return Math.min(exponential, maxBackoffMs);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async recordHop(input: FederationCorrelationContext & {
    latencyMs: number;
    success: boolean;
    errorCode?: string;
  }): Promise<void> {
    if (!this.observability) return;
    await this.observability.recordCrossBrokerHop({
      linkId: input.linkId ?? `federation:${input.remoteBrokerId}`,
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.taskId,
      contextId: input.contextId,
      latencyMs: input.latencyMs,
      success: input.success,
      errorCode: input.errorCode,
      occurredAt: new Date().toISOString(),
    });
  }
}
