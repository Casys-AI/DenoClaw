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
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationAuthorizationDecision,
  FederationBrokerCorrelationContext,
  FederationCorrelationContext,
  FederationDenialDecision,
  FederationDenialKind,
  FederationDeadLetter,
  FederationLink,
  FederationLinkCorrelationContext,
  FederationSessionToken,
  RemoteAgentCatalogEntry,
  SignedCatalogEnvelope,
} from "./types.ts";
import {
  canonicalJson,
  sha256Base64Url,
  verifyCatalogEnvelopeSignature,
} from "./crypto.ts";

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

const DEFAULT_POLICY: FederatedRoutePolicy = {
  policyId: "default",
  preferLocal: false,
  preferredRemoteBrokerIds: [],
  denyAgentIds: [],
};
const SUBMISSION_SETTLE_POLL_MS = 25;
const SUBMISSION_SETTLE_TIMEOUT_MS = 2_000;

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
    const correlation = this.buildCorrelationContext({
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.taskId,
      contextId: input.contextId,
      linkId: `${input.requesterBrokerId}:${input.remoteBrokerId}`,
      traceId: input.traceId,
    });
    const requesterPolicy =
      (await this.policy.getRoutePolicy(input.requesterBrokerId, correlation)) ??
        DEFAULT_POLICY;
    const remotePolicy = await this.policy.getRoutePolicy(
      input.remoteBrokerId,
      correlation,
    );

    const localDenied =
      requesterPolicy.denyAgentIds.includes(input.targetAgent) ||
      (Array.isArray(requesterPolicy.allowAgentIds) &&
        requesterPolicy.allowAgentIds.length > 0 &&
        !requesterPolicy.allowAgentIds.includes(input.targetAgent));
    if (localDenied) {
      await this.recordDenial(correlation, "policy", "DENY_LOCAL_POLICY");
      return {
        decision: "DENY_LOCAL_POLICY",
        reason: "denied_by_local_policy",
      };
    }

    const remoteDenied =
      (remotePolicy?.denyAgentIds.includes(input.targetAgent) ?? false) ||
      (Array.isArray(remotePolicy?.allowAgentIds) &&
        (remotePolicy?.allowAgentIds.length ?? 0) > 0 &&
        !remotePolicy?.allowAgentIds.includes(input.targetAgent));
    if (remoteDenied) {
      await this.recordDenial(correlation, "policy", "DENY_REMOTE_POLICY");
      return {
        decision: "DENY_REMOTE_POLICY",
        reason: "denied_by_remote_policy",
      };
    }

    const catalog = await this.discovery.listRemoteAgents(
      input.remoteBrokerId,
      correlation,
    );
    const available = catalog.some(
      (entry) => entry.agentId === input.targetAgent,
    );
    if (!available) {
      await this.recordDenial(correlation, "not_found", "DENY_REMOTE_NOT_FOUND");
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

    const correlation = this.buildCorrelationContext({
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.task.taskId,
      contextId: input.task.contextId,
      linkId: input.linkId,
      traceId: input.traceId,
    });
    const now = new Date().toISOString();
    const payloadHash = await this.computePayloadHash(input.task);
    const idempotencyKey =
      `${input.remoteBrokerId}:${input.task.taskId}:${payloadHash}`;
    const maxAttempts = input.maxAttempts ?? 3;
    const baseBackoffMs = input.baseBackoffMs ?? 100;
    const maxBackoffMs = input.maxBackoffMs ?? 2_000;
    const initialRecord: FederatedSubmissionRecord = {
      idempotencyKey,
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.task.taskId,
      contextId: correlation.contextId,
      linkId: correlation.linkId,
      traceId: correlation.traceId,
      payloadHash,
      status: "in_flight",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    const created = await this.delivery.createSubmissionRecord(
      initialRecord,
      correlation,
    );
    if (!created) {
      return await this.waitForSettledSubmission(idempotencyKey, correlation);
    }

    let record = initialRecord;

    let lastError = "unknown";
    while (record.attempts < maxAttempts) {
      record = {
        ...record,
        attempts: record.attempts + 1,
        status: "in_flight",
        updatedAt: new Date().toISOString(),
      };
      await this.delivery.upsertSubmissionRecord(record, correlation);
      const attemptStartedAt = Date.now();

      try {
        await this.routing.forwardTask(
          input.task,
          input.remoteBrokerId,
          correlation,
        );
        const latencyMs = Date.now() - attemptStartedAt;
        await this.recordHop({
          ...correlation,
          remoteBrokerId: input.remoteBrokerId,
          taskId: input.task.taskId,
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
        await this.delivery.upsertSubmissionRecord(completed, correlation);
        return {
          status: "forwarded",
          idempotencyKey,
          attempts: completed.attempts,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const latencyMs = Date.now() - attemptStartedAt;
        const errorKind = this.isAuthFailure(lastError) ? "auth" : "delivery";
        await this.recordHop({
          ...correlation,
          remoteBrokerId: input.remoteBrokerId,
          taskId: input.task.taskId,
          latencyMs,
          success: false,
          errorKind,
          errorCode: lastError,
        });
        if (errorKind === "auth") {
          await this.recordDenial(
            correlation,
            "auth",
            "AUTH_FAILED",
            lastError,
          );
        }
        record = {
          ...record,
          lastErrorCode: lastError,
          updatedAt: new Date().toISOString(),
        };
        await this.delivery.upsertSubmissionRecord(record, correlation);
        if (record.attempts < maxAttempts) {
          await this.sleep(
            this.nextBackoffMs(record.attempts, baseBackoffMs, maxBackoffMs),
          );
        }
      }
    }

    const deadLetter: FederationDeadLetter = {
      deadLetterId: crypto.randomUUID(),
      idempotencyKey,
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.task.taskId,
      contextId: correlation.contextId,
      linkId: correlation.linkId,
      traceId: correlation.traceId,
      payloadHash,
      reason: `forward_failed_after_${maxAttempts}_attempts:${lastError}`,
      movedAt: new Date().toISOString(),
    };

    await this.delivery.moveToDeadLetter(deadLetter, correlation);
    const deadLetterRecord: FederatedSubmissionRecord = {
      ...record,
      status: "dead_letter",
      updatedAt: new Date().toISOString(),
      lastErrorCode: lastError,
    };
    await this.delivery.upsertSubmissionRecord(deadLetterRecord, correlation);
    return {
      status: "dead_letter",
      idempotencyKey,
      attempts: deadLetterRecord.attempts,
    };
  }

  private async computePayloadHash(
    task: BrokerTaskSubmitPayload,
  ): Promise<string> {
    return await sha256Base64Url(canonicalJson(task));
  }

  private nextBackoffMs(
    attempt: number,
    baseBackoffMs: number,
    maxBackoffMs: number,
  ): number {
    const exponential = baseBackoffMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(exponential, maxBackoffMs);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async waitForSettledSubmission(
    idempotencyKey: string,
    correlation: FederationCorrelationContext,
  ): Promise<ForwardFederatedTaskResult> {
    const deadline = Date.now() + SUBMISSION_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const existing = await this.delivery?.getSubmissionRecord(
        idempotencyKey,
        correlation,
      );
      if (existing?.status === "completed") {
        return {
          status: "deduplicated",
          idempotencyKey,
          attempts: existing.attempts,
        };
      }
      if (existing?.status === "dead_letter") {
        return {
          status: "dead_letter",
          idempotencyKey,
          attempts: existing.attempts,
        };
      }
      await this.sleep(SUBMISSION_SETTLE_POLL_MS);
    }

    const existing = await this.delivery?.getSubmissionRecord(
      idempotencyKey,
      correlation,
    );
    return {
      status: existing?.status === "dead_letter"
        ? "dead_letter"
        : "deduplicated",
      idempotencyKey,
      attempts: existing?.attempts ?? 0,
    };
  }

  private async recordHop(
    input: FederationCorrelationContext & {
      latencyMs: number;
      success: boolean;
      errorKind?: "delivery" | "auth";
      errorCode?: string;
    },
  ): Promise<void> {
    if (!this.observability) return;
    await this.observability.recordCrossBrokerHop({
      linkId: input.linkId,
      remoteBrokerId: input.remoteBrokerId,
      taskId: input.taskId,
      contextId: input.contextId,
      traceId: input.traceId,
      latencyMs: input.latencyMs,
      success: input.success,
      errorKind: input.errorKind,
      errorCode: input.errorCode,
      occurredAt: new Date().toISOString(),
    });
  }

  private async recordDenial(
    correlation: FederationCorrelationContext,
    kind: FederationDenialKind,
    decision: FederationDenialDecision,
    errorCode?: string,
  ): Promise<void> {
    if (!this.observability) return;
    await this.observability.recordFederationDenial({
      ...correlation,
      kind,
      decision,
      errorCode,
      occurredAt: new Date().toISOString(),
    });
  }

  private isAuthFailure(errorCode: string): boolean {
    const normalized = errorCode.toLowerCase();
    return normalized.includes("auth") ||
      normalized.includes("unauthorized") ||
      normalized.includes("forbidden") ||
      normalized.includes("token") ||
      normalized.includes("session") ||
      normalized.includes("expired");
  }

  private buildBrokerCorrelationContext(
    context: FederationBrokerCorrelationContext,
  ): FederationBrokerCorrelationContext {
    return {
      remoteBrokerId: context.remoteBrokerId,
      traceId: context.traceId,
    };
  }

  private buildLinkCorrelationContext(
    context: FederationLinkCorrelationContext,
  ): FederationLinkCorrelationContext {
    return {
      remoteBrokerId: context.remoteBrokerId,
      linkId: context.linkId,
      traceId: context.traceId,
    };
  }

  private buildCorrelationContext(
    context: FederationCorrelationContext,
  ): FederationCorrelationContext {
    return {
      remoteBrokerId: context.remoteBrokerId,
      taskId: context.taskId,
      contextId: context.contextId,
      linkId: context.linkId,
      traceId: context.traceId,
    };
  }
}
