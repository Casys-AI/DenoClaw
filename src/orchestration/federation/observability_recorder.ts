import type { FederationObservabilityPort } from "./ports.ts";
import type {
  FederationCorrelationContext,
  FederationDenialDecision,
  FederationDenialKind,
} from "./types.ts";

export class FederationObservabilityRecorder {
  constructor(
    private readonly observability: FederationObservabilityPort | null,
  ) {}

  async recordHop(
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

  async recordDenial(
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

  isAuthFailure(errorCode: string): boolean {
    const normalized = errorCode.toLowerCase();
    return normalized.includes("auth") ||
      normalized.includes("unauthorized") ||
      normalized.includes("forbidden") ||
      normalized.includes("token") ||
      normalized.includes("session") ||
      normalized.includes("expired");
  }
}
