import type {
  BrokerIdentity,
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationBrokerCorrelationContext,
  FederationCorrelationContext,
  FederationDeadLetter,
  FederationLink,
  FederationLinkCorrelationContext,
  FederationLinkState,
  FederationSessionToken,
  FederationStatsSnapshot,
  FederationTraceContext,
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

  async acknowledgeLink(
    linkId: string,
    accepted: boolean,
    correlation: FederationLinkCorrelationContext,
  ): Promise<void> {
    await this.setLinkState(
      linkId,
      accepted ? "active" : "failed",
      correlation,
    );
  }

  async terminateLink(
    linkId: string,
    _correlation: FederationLinkCorrelationContext,
  ): Promise<void> {
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
    _correlation: FederationLinkCorrelationContext,
    ttlSeconds = 900,
  ): Promise<FederationSessionToken> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be a positive number");
    }

    const link = await this.kv.get<FederationLink>([
      "federation",
      "links",
      linkId,
    ]);
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

    await this.kv.set(
      ["federation", "sessions", linkId, session.sessionId],
      session,
    );
    return session;
  }

  async refreshTrust(
    remoteBrokerId: string,
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<BrokerIdentity> {
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
    _correlation: FederationBrokerCorrelationContext,
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
    correlation: FederationBrokerCorrelationContext,
  ): Promise<Record<string, unknown> | null> {
    const entries = await this.listRemoteAgents(remoteBrokerId, correlation);
    return entries.find((entry) => entry.agentId === agentId)?.card ?? null;
  }

  async setRemoteCatalog(
    remoteBrokerId: string,
    entries: RemoteAgentCatalogEntry[],
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<void> {
    await this.kv.set(["federation", "catalog", remoteBrokerId], entries);
  }

  async upsertIdentity(
    identity: BrokerIdentity,
    _correlation?: FederationTraceContext,
  ): Promise<void> {
    await this.kv.set(["federation", "identity", identity.brokerId], identity);
  }

  async getIdentity(
    brokerId: string,
    _correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity | null> {
    const entry = await this.kv.get<BrokerIdentity>([
      "federation",
      "identity",
      brokerId,
    ]);
    return entry.value ?? null;
  }

  async listIdentities(
    _correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity[]> {
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

  async revokeIdentity(
    brokerId: string,
    correlation?: FederationTraceContext,
  ): Promise<void> {
    const existing = await this.getIdentity(brokerId, correlation);
    if (!existing) return;
    await this.upsertIdentity({ ...existing, status: "revoked" }, correlation);
  }

  async rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
    correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity> {
    const now = new Date().toISOString();
    const existing = await this.getIdentity(brokerId, correlation);
    const updated: BrokerIdentity = existing
      ? {
        ...existing,
        publicKeys: [
          nextPublicKey,
          ...existing.publicKeys.filter((key) => key !== nextPublicKey),
        ],
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
    await this.upsertIdentity(updated, correlation);
    return updated;
  }

  async setRoutePolicy(
    brokerId: string,
    policy: FederatedRoutePolicy,
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<void> {
    await this.kv.set(["federation", "policies", brokerId], policy);
  }

  async getRoutePolicy(
    brokerId: string,
    _correlation: FederationBrokerCorrelationContext,
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
    _correlation: FederationLinkCorrelationContext,
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
    await this.kv.set(
      ["federation", "events", event.taskId, crypto.randomUUID()],
      event,
    );

    for (const subscriber of this.federationEventSubscribers.values()) {
      subscriber(event);
    }
  }

  streamFederationEvents(
    onEvent: (event: CrossBrokerHopEvent) => void,
  ): Promise<() => void> {
    const subscriberId = crypto.randomUUID();
    this.federationEventSubscribers.set(subscriberId, onEvent);
    return Promise.resolve(() => {
      this.federationEventSubscribers.delete(subscriberId);
    });
  }

  async createSubmissionRecord(
    record: FederatedSubmissionRecord,
    _correlation: FederationCorrelationContext,
  ): Promise<boolean> {
    const key: Deno.KvKey = [
      "federation",
      "submissions",
      record.idempotencyKey,
    ];
    const result = await this.kv
      .atomic()
      .check({ key, versionstamp: null })
      .set(key, record)
      .commit();
    return result.ok;
  }

  async getSubmissionRecord(
    idempotencyKey: string,
    _correlation: FederationCorrelationContext,
  ): Promise<FederatedSubmissionRecord | null> {
    const entry = await this.kv.get<FederatedSubmissionRecord>([
      "federation",
      "submissions",
      idempotencyKey,
    ]);
    return entry.value ?? null;
  }

  async upsertSubmissionRecord(
    record: FederatedSubmissionRecord,
    _correlation: FederationCorrelationContext,
  ): Promise<void> {
    await this.kv.set(
      ["federation", "submissions", record.idempotencyKey],
      record,
    );
  }

  async moveToDeadLetter(
    entry: FederationDeadLetter,
    _correlation: FederationCorrelationContext,
  ): Promise<void> {
    await this.kv.set(
      ["federation", "dead-letter", entry.remoteBrokerId, entry.deadLetterId],
      entry,
    );
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

  async getFederationStats(remoteBrokerId?: string): Promise<FederationStatsSnapshot> {
    const eventPrefix: Deno.KvKey = ["federation", "events"];
    const byLink = new Map<
      string,
      {
        linkId: string;
        remoteBrokerId: string;
        successCount: number;
        errorCount: number;
        latencies: number[];
        lastTaskId?: string;
        lastTraceId?: string;
        lastOccurredAt?: string;
      }
    >();
    let successCount = 0;
    let errorCount = 0;

    for await (
      const entry of this.kv.list<CrossBrokerHopEvent>({
        prefix: eventPrefix,
      })
    ) {
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
      if (
        !link.lastOccurredAt ||
        event.occurredAt.localeCompare(link.lastOccurredAt) > 0
      ) {
        link.lastOccurredAt = event.occurredAt;
        link.lastTaskId = event.taskId;
        link.lastTraceId = event.traceId;
      }
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
      lastTaskId: entry.lastTaskId,
      lastTraceId: entry.lastTraceId,
      lastOccurredAt: entry.lastOccurredAt,
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
