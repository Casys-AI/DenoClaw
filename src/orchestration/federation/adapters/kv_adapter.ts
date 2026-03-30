import type {
  BrokerIdentity,
  FederationDeadLetter,
  FederationSessionToken,
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationLink,
  FederationLinkState,
  FederationStatsSnapshot,
  RemoteAgentCatalogEntry,
} from "../types.ts";
import type {
  CrossBrokerHopEvent,
  EstablishFederationLinkInput,
  FederationControlPort,
  FederationDeliveryPort,
  FederationDiscoveryPort,
  FederationIdentityPort,
  FederationMetricsPort,
  FederationObservabilityPort,
  FederationPolicyPort,
} from "../ports.ts";

export class KvFederationAdapter
  implements
    FederationControlPort,
    FederationDiscoveryPort,
    FederationPolicyPort,
    FederationIdentityPort,
    FederationObservabilityPort,
    FederationDeliveryPort,
    FederationMetricsPort {
  private readonly federationEventSubscribers = new Map<
    string,
    (event: CrossBrokerHopEvent) => void
  >();

  constructor(private readonly kv: Deno.Kv) {}

  async establishLink(
    input: EstablishFederationLinkInput,
  ): Promise<FederationLink> {
    const link: FederationLink = {
      linkId: input.linkId ?? `${input.localBrokerId}:${input.remoteBrokerId}`,
      localBrokerId: input.localBrokerId,
      remoteBrokerId: input.remoteBrokerId,
      state: "active",
      lastHeartbeatAt: new Date().toISOString(),
    };
    await this.kv.set(["federation", "links", link.linkId], link);
    return link;
  }

  async acknowledgeLink(linkId: string, accepted: boolean): Promise<void> {
    await this.setLinkState(linkId, accepted ? "active" : "failed");
  }

  async terminateLink(linkId: string): Promise<void> {
    await this.kv.delete(["federation", "links", linkId]);
  }

  async listLinks(): Promise<FederationLink[]> {
    const links: FederationLink[] = [];
    for await (
      const entry of this.kv.list<FederationLink>({
        prefix: ["federation", "links"],
      })
    ) {
      if (entry.value) links.push(entry.value);
    }
    return links;
  }

  async rotateLinkSession(
    linkId: string,
    ttlSeconds = 900,
  ): Promise<FederationSessionToken> {
    const link = await this.kv.get<FederationLink>(["federation", "links", linkId]);
    if (!link.value) {
      throw new Error(`Federation link not found: ${linkId}`);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const session: FederationSessionToken = {
      sessionId: crypto.randomUUID(),
      linkId,
      remoteBrokerId: link.value.remoteBrokerId,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "active",
    };

    await this.kv.set(["federation", "sessions", linkId, session.sessionId], session);
    return session;
  }

  async refreshTrust(remoteBrokerId: string): Promise<BrokerIdentity> {
    const identity = {
      brokerId: remoteBrokerId,
      instanceUrl: "",
      publicKeys: [],
      status: "pending" as const,
    };
    await this.upsertIdentity(identity);
    return identity;
  }

  async listRemoteAgents(
    remoteBrokerId: string,
  ): Promise<RemoteAgentCatalogEntry[]> {
    const entry = await this.kv.get<RemoteAgentCatalogEntry[]>([
      "federation",
      "catalog",
      remoteBrokerId,
    ]);
    return entry.value ?? [];
  }

  async getRemoteAgentCard(
    remoteBrokerId: string,
    agentId: string,
  ): Promise<Record<string, unknown> | null> {
    const entries = await this.listRemoteAgents(remoteBrokerId);
    return entries.find((entry) => entry.agentId === agentId)?.card ?? null;
  }

  async setRemoteCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
  ): Promise<void> {
    await this.kv.set(["federation", "catalog", remoteBrokerId], entries);
  }

  async upsertIdentity(identity: BrokerIdentity): Promise<void> {
    await this.kv.set(["federation", "identity", identity.brokerId], identity);
  }

  async getIdentity(brokerId: string): Promise<BrokerIdentity | null> {
    const entry = await this.kv.get<BrokerIdentity>([
      "federation",
      "identity",
      brokerId,
    ]);
    return entry.value ?? null;
  }

  async listIdentities(): Promise<BrokerIdentity[]> {
    const identities: BrokerIdentity[] = [];
    for await (
      const entry of this.kv.list<BrokerIdentity>({
        prefix: ["federation", "identity"],
      })
    ) {
      if (entry.value) identities.push(entry.value);
    }
    return identities;
  }

  async revokeIdentity(brokerId: string): Promise<void> {
    const existing = await this.getIdentity(brokerId);
    if (!existing) return;
    await this.upsertIdentity({ ...existing, status: "revoked" });
  }

  async rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
  ): Promise<BrokerIdentity> {
    const now = new Date().toISOString();
    const existing = await this.getIdentity(brokerId);
    const updated: BrokerIdentity = existing
      ? {
        ...existing,
        publicKeys: [nextPublicKey, ...existing.publicKeys.filter((key) => key !== nextPublicKey)],
        activeKeyId: nextPublicKey,
        rotatedAt: now,
      }
      : {
        brokerId,
        instanceUrl: "",
        publicKeys: [nextPublicKey],
        activeKeyId: nextPublicKey,
        rotatedAt: now,
        status: "pending",
      };
    await this.upsertIdentity(updated);
    return updated;
  }

  async setRoutePolicy(
    brokerId: string,
    policy: FederatedRoutePolicy,
  ): Promise<void> {
    await this.kv.set(["federation", "policies", brokerId], policy);
  }

  async getRoutePolicy(
    brokerId: string,
  ): Promise<FederatedRoutePolicy | null> {
    const entry = await this.kv.get<FederatedRoutePolicy>([
      "federation",
      "policies",
      brokerId,
    ]);
    return entry.value ?? null;
  }

  async setLinkState(
    linkId: string,
    state: FederationLinkState,
  ): Promise<void> {
    const key: Deno.KvKey = ["federation", "links", linkId];
    const entry = await this.kv.get<FederationLink>(key);
    if (!entry.value) return;
    await this.kv.set(key, {
      ...entry.value,
      state,
      lastHeartbeatAt: new Date().toISOString(),
    });
  }

  async recordCrossBrokerHop(event: CrossBrokerHopEvent): Promise<void> {
    await this.kv.set([
      "federation",
      "events",
      event.taskId,
      crypto.randomUUID(),
    ], event);

    for (const subscriber of this.federationEventSubscribers.values()) {
      subscriber(event);
    }
  }

  async streamFederationEvents(
    onEvent: (event: CrossBrokerHopEvent) => void,
  ): Promise<() => void> {
    const subscriberId = crypto.randomUUID();
    this.federationEventSubscribers.set(subscriberId, onEvent);
    return () => {
      this.federationEventSubscribers.delete(subscriberId);
    };
  }

  async getSubmissionRecord(
    idempotencyKey: string,
  ): Promise<FederatedSubmissionRecord | null> {
    const entry = await this.kv.get<FederatedSubmissionRecord>([
      "federation",
      "submissions",
      idempotencyKey,
    ]);
    return entry.value ?? null;
  }

  async upsertSubmissionRecord(record: FederatedSubmissionRecord): Promise<void> {
    await this.kv.set([
      "federation",
      "submissions",
      record.idempotencyKey,
    ], record);
  }

  async moveToDeadLetter(entry: FederationDeadLetter): Promise<void> {
    await this.kv.set([
      "federation",
      "dead-letter",
      entry.remoteBrokerId,
      entry.deadLetterId,
    ], entry);
  }

  async listDeadLetters(remoteBrokerId?: string): Promise<FederationDeadLetter[]> {
    const prefix: Deno.KvKey = remoteBrokerId
      ? ["federation", "dead-letter", remoteBrokerId]
      : ["federation", "dead-letter"];
    const entries: FederationDeadLetter[] = [];
    for await (const entry of this.kv.list<FederationDeadLetter>({ prefix })) {
      if (entry.value) entries.push(entry.value);
    }
    return entries;
  }

  async getFederationStats(
    remoteBrokerId?: string,
  ): Promise<FederationStatsSnapshot> {
    const eventPrefix: Deno.KvKey = ["federation", "events"];
    const byLink = new Map<string, {
      linkId: string;
      remoteBrokerId: string;
      successCount: number;
      errorCount: number;
      latencies: number[];
    }>();
    let successCount = 0;
    let errorCount = 0;

    for await (const entry of this.kv.list<CrossBrokerHopEvent>({ prefix: eventPrefix })) {
      const event = entry.value;
      if (!event) continue;
      if (remoteBrokerId && event.remoteBrokerId !== remoteBrokerId) continue;

      const link = byLink.get(event.linkId) ?? {
        linkId: event.linkId,
        remoteBrokerId: event.remoteBrokerId,
        successCount: 0,
        errorCount: 0,
        latencies: [],
      };
      link.latencies.push(event.latencyMs);
      if (event.success) {
        link.successCount += 1;
        successCount += 1;
      } else {
        link.errorCount += 1;
        errorCount += 1;
      }
      byLink.set(event.linkId, link);
    }

    const deadLetters = await this.listDeadLetters(remoteBrokerId);
    const links = [...byLink.values()].map((entry) => ({
      linkId: entry.linkId,
      remoteBrokerId: entry.remoteBrokerId,
      successCount: entry.successCount,
      errorCount: entry.errorCount,
      p50LatencyMs: this.percentile(entry.latencies, 50),
      p95LatencyMs: this.percentile(entry.latencies, 95),
    }));

    return {
      links,
      successCount,
      errorCount,
      deadLetterBacklog: deadLetters.length,
    };
  }

  private percentile(values: number[], pct: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((pct / 100) * sorted.length) - 1;
    const index = Math.min(Math.max(rank, 0), sorted.length - 1);
    return sorted[index];
  }
}
