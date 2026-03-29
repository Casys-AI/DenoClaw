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
  status: "trusted" | "pending" | "revoked";
}

export interface RemoteAgentCatalogEntry {
  remoteBrokerId: string;
  agentId: string;
  card: Record<string, unknown>;
  capabilities: string[];
  visibility: "public" | "restricted";
}

export interface FederatedRoutePolicy {
  policyId: string;
  preferLocal: boolean;
  preferredRemoteBrokerIds: string[];
  denyAgentIds: string[];
  allowAgentIds?: string[];
  maxLatencyMs?: number;
}
