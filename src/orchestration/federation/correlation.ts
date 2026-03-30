import type {
  FederationBrokerCorrelationContext,
  FederationCorrelationContext,
  FederationLinkCorrelationContext,
} from "./types.ts";

export function buildBrokerCorrelationContext(
  context: FederationBrokerCorrelationContext,
): FederationBrokerCorrelationContext {
  return {
    remoteBrokerId: context.remoteBrokerId,
    traceId: context.traceId,
  };
}

export function buildLinkCorrelationContext(
  context: FederationLinkCorrelationContext,
): FederationLinkCorrelationContext {
  return {
    remoteBrokerId: context.remoteBrokerId,
    linkId: context.linkId,
    traceId: context.traceId,
  };
}

export function buildCorrelationContext(
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
