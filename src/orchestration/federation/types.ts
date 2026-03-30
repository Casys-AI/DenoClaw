export type FederationLinkState =
  | "opening"
  | "active"
  | "degraded"
  | "closing"
  | "closed"
  | "failed";

export interface FederationLink {
  linkId: string;
  localBrokerId: string;
  remoteBrokerId: string;
  state: FederationLinkState;
  lastHeartbeatAt?: string;
  latencyMs?: number;
}

export interface BrokerIdentity {
  brokerId: string;
  instanceUrl: string;
  publicKeys: string[];
  activeKeyId?: string;
  rotatedAt?: string;
  status: "trusted" | "pending" | "revoked";
}

export interface RemoteAgentCatalogEntry {
  remoteBrokerId: string;
  agentId: string;
  card: Record<string, unknown>;
  capabilities: string[];
  visibility: "public" | "restricted";
}

export interface SignedCatalogEnvelope {
  remoteBrokerId: string;
  schemaVersion: 1;
  signedAt: string;
  keyId?: string;
  signature: string;
  entries: RemoteAgentCatalogEntry[];
}

export type FederationAuthorizationDecision =
  | "ALLOW"
  | "DENY_LOCAL_POLICY"
  | "DENY_REMOTE_POLICY"
  | "DENY_REMOTE_NOT_FOUND";

export interface FederatedSubmissionRecord {
  idempotencyKey: string;
  remoteBrokerId: string;
  taskId: string;
  contextId: string;
  linkId: string;
  traceId: string;
  payloadHash: string;
  status: "in_flight" | "completed" | "dead_letter";
  resultRef?: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastErrorCode?: string;
}

export interface FederationDeadLetter {
  deadLetterId: string;
  idempotencyKey: string;
  remoteBrokerId: string;
  taskId: string;
  contextId: string;
  linkId: string;
  traceId: string;
  payloadHash: string;
  reason: string;
  movedAt: string;
}

export interface FederationTraceContext {
  traceId: string;
}

export interface FederationBrokerCorrelationContext
  extends FederationTraceContext {
  remoteBrokerId: string;
}

export interface FederationLinkCorrelationContext
  extends FederationBrokerCorrelationContext {
  linkId: string;
}

export interface FederationCorrelationContext
  extends FederationLinkCorrelationContext {
  taskId: string;
  contextId: string;
}

export interface FederationLinkStats {
  linkId: string;
  remoteBrokerId: string;
  successCount: number;
  errorCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  lastTaskId?: string;
  lastTraceId?: string;
  lastOccurredAt?: string;
}

export interface FederationStatsSnapshot {
  links: FederationLinkStats[];
  successCount: number;
  errorCount: number;
  deadLetterBacklog: number;
}

export interface FederationSessionToken {
  sessionId: string;
  linkId: string;
  remoteBrokerId: string;
  issuedAt: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
}

export interface FederatedRoutePolicy {
  policyId: string;
  preferLocal: boolean;
  preferredRemoteBrokerIds: string[];
  denyAgentIds: string[];
  allowAgentIds?: string[];
  maxLatencyMs?: number;
}
