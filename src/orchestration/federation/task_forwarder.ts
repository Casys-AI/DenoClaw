import type { BrokerTaskSubmitPayload } from "../types.ts";
import type { FederationDeliveryPort, FederationRoutingPort } from "./ports.ts";
import type {
  FederatedSubmissionRecord,
  FederationDeadLetter,
} from "./types.ts";
import { canonicalJson, sha256Base64Url } from "./crypto.ts";
import { buildCorrelationContext } from "./correlation.ts";
import type { FederationObservabilityRecorder } from "./observability_recorder.ts";

const SUBMISSION_SETTLE_POLL_MS = 25;
const SUBMISSION_SETTLE_TIMEOUT_MS = 2_000;

interface ForwardFederatedTaskInputLike {
  remoteBrokerId: string;
  task: BrokerTaskSubmitPayload & { contextId: string };
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  linkId: string;
  traceId: string;
}

interface ForwardFederatedTaskResultLike {
  status: "forwarded" | "deduplicated" | "dead_letter";
  idempotencyKey: string;
  attempts: number;
}

interface ReplayFederatedDeadLetterInputLike {
  remoteBrokerId: string;
  deadLetterId: string;
  traceId: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export class FederationDeadLetterNotFoundError extends Error {
  constructor(
    readonly remoteBrokerId: string,
    readonly deadLetterId: string,
  ) {
    super(
      `Federation dead-letter not found: ${remoteBrokerId}/${deadLetterId}`,
    );
    this.name = "FederationDeadLetterNotFoundError";
  }
}

export interface FederationTaskForwarderDeps {
  routing: FederationRoutingPort;
  delivery: FederationDeliveryPort;
  recorder: FederationObservabilityRecorder;
}

export class FederationTaskForwarder {
  constructor(private readonly deps: FederationTaskForwarderDeps) {}

  async replayDeadLetter(
    input: ReplayFederatedDeadLetterInputLike,
  ): Promise<ForwardFederatedTaskResultLike> {
    const deadLetter = await this.deps.delivery.claimDeadLetter(
      input.remoteBrokerId,
      input.deadLetterId,
    );
    if (!deadLetter) {
      throw new FederationDeadLetterNotFoundError(
        input.remoteBrokerId,
        input.deadLetterId,
      );
    }

    const correlation = buildCorrelationContext({
      remoteBrokerId: deadLetter.remoteBrokerId,
      taskId: deadLetter.task.taskId,
      contextId: deadLetter.task.contextId,
      linkId: deadLetter.linkId,
      traceId: input.traceId,
    });

    await this.deps.delivery.deleteSubmissionRecord(
      deadLetter.idempotencyKey,
      correlation,
    );

    return await this.forwardTaskIdempotent({
      remoteBrokerId: deadLetter.remoteBrokerId,
      task: deadLetter.task,
      maxAttempts: input.maxAttempts,
      baseBackoffMs: input.baseBackoffMs,
      maxBackoffMs: input.maxBackoffMs,
      linkId: deadLetter.linkId,
      traceId: input.traceId,
    });
  }

  async forwardTaskIdempotent(
    input: ForwardFederatedTaskInputLike,
  ): Promise<ForwardFederatedTaskResultLike> {
    const correlation = buildCorrelationContext({
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
    const created = await this.deps.delivery.createSubmissionRecord(
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
      await this.deps.delivery.upsertSubmissionRecord(record, correlation);
      const attemptStartedAt = Date.now();

      try {
        await this.deps.routing.forwardTask(
          input.task,
          input.remoteBrokerId,
          correlation,
        );
        const latencyMs = Date.now() - attemptStartedAt;
        await this.deps.recorder.recordHop({
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
        await this.deps.delivery.upsertSubmissionRecord(completed, correlation);
        return {
          status: "forwarded",
          idempotencyKey,
          attempts: completed.attempts,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const latencyMs = Date.now() - attemptStartedAt;
        const errorKind = this.deps.recorder.isAuthFailure(lastError)
          ? "auth"
          : "delivery";
        await this.deps.recorder.recordHop({
          ...correlation,
          remoteBrokerId: input.remoteBrokerId,
          taskId: input.task.taskId,
          latencyMs,
          success: false,
          errorKind,
          errorCode: lastError,
        });
        if (errorKind === "auth") {
          await this.deps.recorder.recordDenial(
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
        await this.deps.delivery.upsertSubmissionRecord(record, correlation);
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
      task: input.task,
      payloadHash,
      attempts: record.attempts,
      reason: `forward_failed_after_${maxAttempts}_attempts:${lastError}`,
      movedAt: new Date().toISOString(),
    };

    await this.deps.delivery.moveToDeadLetter(deadLetter, correlation);
    const deadLetterRecord: FederatedSubmissionRecord = {
      ...record,
      status: "dead_letter",
      updatedAt: new Date().toISOString(),
      lastErrorCode: lastError,
    };
    await this.deps.delivery.upsertSubmissionRecord(
      deadLetterRecord,
      correlation,
    );
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
    correlation: {
      remoteBrokerId: string;
      taskId: string;
      contextId: string;
      linkId: string;
      traceId: string;
    },
  ): Promise<ForwardFederatedTaskResultLike> {
    const deadline = Date.now() + SUBMISSION_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const existing = await this.deps.delivery.getSubmissionRecord(
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

    const existing = await this.deps.delivery.getSubmissionRecord(
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
}
