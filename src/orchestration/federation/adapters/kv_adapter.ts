import type {
  BrokerIdentity,
  FederatedRoutePolicy,
  FederatedSubmissionRecord,
  FederationBrokerCorrelationContext,
  FederationCorrelationContext,
  FederationDenialBreakdown,
  FederationDeadLetter,
  FederationLink,
  FederationLinkStats,
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
  FederationEvent,
  FederationControlPort,
  FederationDeliveryPort,
  FederationDenialEvent,
  FederationDiscoveryPort,
  FederationIdentityPort,
  FederationMetricsPort,
  FederationObservabilityPort,
  FederationPolicyPort,
} from "../ports.ts";

const MAX_KV_UPDATE_RETRIES = 8;

interface FederationStatsSummaryAggregate {
  successCount: number;
  errorCount: number;
  denials: FederationDenialBreakdown;
  deadLetterBacklog: number;
}

interface FederationLinkStatsAggregate extends FederationLinkStats {
  latencySamples: number[];
}

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
    (event: FederationEvent) => void
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
    await this.ensureLinkStatsAggregate(link);
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
    await this.persistHopEvent(event);

    for (const subscriber of this.federationEventSubscribers.values()) {
      subscriber(event);
    }
  }

  streamFederationEvents(
    onEvent: (event: FederationEvent) => void,
  ): Promise<() => void> {
    const subscriberId = crypto.randomUUID();
    this.federationEventSubscribers.set(subscriberId, onEvent);
    return Promise.resolve(() => {
      this.federationEventSubscribers.delete(subscriberId);
    });
  }

  async recordFederationDenial(event: FederationDenialEvent): Promise<void> {
    await this.persistDenialEvent(event);

    for (const subscriber of this.federationEventSubscribers.values()) {
      subscriber(event);
    }
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
    const key: Deno.KvKey = [
      "federation",
      "dead-letter",
      entry.remoteBrokerId,
      entry.deadLetterId,
    ];
    await this.persistDeadLetterEntry(key, entry);
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
    const aggregated = await this.readAggregatedFederationStats(remoteBrokerId);
    if (aggregated) return aggregated;
    return await this.scanFederationStats(remoteBrokerId);
  }

  private emptyDenials(): FederationDenialBreakdown {
    return {
      policy: 0,
      auth: 0,
      notFound: 0,
    };
  }

  private emptySummaryAggregate(): FederationStatsSummaryAggregate {
    return {
      successCount: 0,
      errorCount: 0,
      denials: this.emptyDenials(),
      deadLetterBacklog: 0,
    };
  }

  private emptyLinkAggregate(
    remoteBrokerId: string,
    linkId: string,
  ): FederationLinkStatsAggregate {
    return {
      linkId,
      remoteBrokerId,
      successCount: 0,
      errorCount: 0,
      denials: this.emptyDenials(),
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      latencySamples: [],
    };
  }

  private incrementDenials(
    denials: FederationDenialBreakdown,
    kind: FederationDenialEvent["kind"],
  ): FederationDenialBreakdown {
    switch (kind) {
      case "policy":
        return { ...denials, policy: denials.policy + 1 };
      case "auth":
        return { ...denials, auth: denials.auth + 1 };
      case "not_found":
        return { ...denials, notFound: denials.notFound + 1 };
    }
  }

  private incrementDeadLetterBacklog(
    summary: FederationStatsSummaryAggregate | null | undefined,
  ): FederationStatsSummaryAggregate {
    const current = summary ?? this.emptySummaryAggregate();
    return {
      ...current,
      deadLetterBacklog: current.deadLetterBacklog + 1,
    };
  }

  private summaryKey(remoteBrokerId?: string): Deno.KvKey {
    return remoteBrokerId
      ? ["federation", "stats", "summary", remoteBrokerId]
      : ["federation", "stats", "summary"];
  }

  private linkKey(remoteBrokerId: string, linkId: string): Deno.KvKey {
    return ["federation", "stats", "links", remoteBrokerId, linkId];
  }

  private linkPrefix(remoteBrokerId?: string): Deno.KvKey {
    return remoteBrokerId
      ? ["federation", "stats", "links", remoteBrokerId]
      : ["federation", "stats", "links"];
  }

  private async ensureLinkStatsAggregate(link: FederationLink): Promise<void> {
    await this.updateSummaryAggregate(undefined, (summary) => summary);
    await this.updateSummaryAggregate(link.remoteBrokerId, (summary) => summary);
    await this.updateLinkAggregate(link.remoteBrokerId, link.linkId, (current) => ({
      ...current,
      lastOccurredAt: current.lastOccurredAt ?? link.lastHeartbeatAt,
    }));
  }

  private async updateSummaryAggregate(
    remoteBrokerId: string | undefined,
    update: (
      current: FederationStatsSummaryAggregate,
    ) => FederationStatsSummaryAggregate,
  ): Promise<void> {
    const key = this.summaryKey(remoteBrokerId);
    await this.updateKvValue(
      key,
      () => this.emptySummaryAggregate(),
      update,
    );
  }

  private async updateLinkAggregate(
    remoteBrokerId: string,
    linkId: string,
    update: (
      current: FederationLinkStatsAggregate,
    ) => FederationLinkStatsAggregate,
  ): Promise<void> {
    const key = this.linkKey(remoteBrokerId, linkId);
    await this.updateKvValue(
      key,
      () => this.emptyLinkAggregate(remoteBrokerId, linkId),
      update,
    );
  }

  private async updateKvValue<T>(
    key: Deno.KvKey,
    createEmpty: () => T,
    update: (current: T) => T,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_KV_UPDATE_RETRIES; attempt++) {
      const entry = await this.kv.get<T>(key);
      const current = entry.value ?? createEmpty();
      const next = update(current);
      const committed = await this.kv
        .atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .set(key, next)
        .commit();
      if (committed.ok) return;
    }
    throw new Error(`Failed to update federation aggregate at ${key.join(":")}`);
  }

  private async persistHopEvent(event: CrossBrokerHopEvent): Promise<void> {
    const eventKey: Deno.KvKey = [
      "federation",
      "events",
      event.taskId,
      crypto.randomUUID(),
    ];
    const globalSummaryKey = this.summaryKey();
    const remoteSummaryKey = this.summaryKey(event.remoteBrokerId);
    const linkAggregateKey = this.linkKey(event.remoteBrokerId, event.linkId);
    for (let attempt = 0; attempt < MAX_KV_UPDATE_RETRIES; attempt++) {
      const [eventEntry, globalSummaryEntry, remoteSummaryEntry, linkEntry] =
        await Promise.all([
          this.kv.get<CrossBrokerHopEvent>(eventKey),
          this.kv.get<FederationStatsSummaryAggregate>(globalSummaryKey),
          this.kv.get<FederationStatsSummaryAggregate>(remoteSummaryKey),
          this.kv.get<FederationLinkStatsAggregate>(linkAggregateKey),
        ]);
      const latencySamples = [
        ...(linkEntry.value?.latencySamples ?? []),
        event.latencyMs,
      ];
      const nextLink: FederationLinkStatsAggregate = {
        ...(linkEntry.value ??
          this.emptyLinkAggregate(event.remoteBrokerId, event.linkId)),
        successCount:
          (linkEntry.value?.successCount ?? 0) + (event.success ? 1 : 0),
        errorCount: (linkEntry.value?.errorCount ?? 0) +
          (!event.success && event.errorKind !== "auth" ? 1 : 0),
        p50LatencyMs: this.percentile(latencySamples, 50),
        p95LatencyMs: this.percentile(latencySamples, 95),
        lastTaskId: event.taskId,
        lastTraceId: event.traceId,
        lastOccurredAt: event.occurredAt,
        latencySamples,
      };
      const nextGlobal: FederationStatsSummaryAggregate = {
        ...(globalSummaryEntry.value ?? this.emptySummaryAggregate()),
        successCount: (globalSummaryEntry.value?.successCount ?? 0) +
          (event.success ? 1 : 0),
        errorCount: (globalSummaryEntry.value?.errorCount ?? 0) +
          (!event.success && event.errorKind !== "auth" ? 1 : 0),
      };
      const nextRemote: FederationStatsSummaryAggregate = {
        ...(remoteSummaryEntry.value ?? this.emptySummaryAggregate()),
        successCount: (remoteSummaryEntry.value?.successCount ?? 0) +
          (event.success ? 1 : 0),
        errorCount: (remoteSummaryEntry.value?.errorCount ?? 0) +
          (!event.success && event.errorKind !== "auth" ? 1 : 0),
      };
      const committed = await this.kv
        .atomic()
        .check({ key: eventKey, versionstamp: eventEntry.versionstamp })
        .check({
          key: globalSummaryKey,
          versionstamp: globalSummaryEntry.versionstamp,
        })
        .check({
          key: remoteSummaryKey,
          versionstamp: remoteSummaryEntry.versionstamp,
        })
        .check({
          key: linkAggregateKey,
          versionstamp: linkEntry.versionstamp,
        })
        .set(eventKey, event)
        .set(globalSummaryKey, nextGlobal)
        .set(remoteSummaryKey, nextRemote)
        .set(linkAggregateKey, nextLink)
        .commit();
      if (committed.ok) return;
    }
    throw new Error("Failed to persist federation hop aggregate");
  }

  private async persistDenialEvent(event: FederationDenialEvent): Promise<void> {
    const eventKey: Deno.KvKey = [
      "federation",
      "denials",
      event.remoteBrokerId,
      crypto.randomUUID(),
    ];
    const globalSummaryKey = this.summaryKey();
    const remoteSummaryKey = this.summaryKey(event.remoteBrokerId);
    const linkAggregateKey = this.linkKey(event.remoteBrokerId, event.linkId);
    for (let attempt = 0; attempt < MAX_KV_UPDATE_RETRIES; attempt++) {
      const [eventEntry, globalSummaryEntry, remoteSummaryEntry, linkEntry] =
        await Promise.all([
          this.kv.get<FederationDenialEvent>(eventKey),
          this.kv.get<FederationStatsSummaryAggregate>(globalSummaryKey),
          this.kv.get<FederationStatsSummaryAggregate>(remoteSummaryKey),
          this.kv.get<FederationLinkStatsAggregate>(linkAggregateKey),
        ]);
      const nextLink: FederationLinkStatsAggregate = {
        ...(linkEntry.value ??
          this.emptyLinkAggregate(event.remoteBrokerId, event.linkId)),
        denials: this.incrementDenials(
          linkEntry.value?.denials ?? this.emptyDenials(),
          event.kind,
        ),
        lastTaskId: event.taskId,
        lastTraceId: event.traceId,
        lastOccurredAt: event.occurredAt,
      };
      const nextGlobal: FederationStatsSummaryAggregate = {
        ...(globalSummaryEntry.value ?? this.emptySummaryAggregate()),
        denials: this.incrementDenials(
          globalSummaryEntry.value?.denials ?? this.emptyDenials(),
          event.kind,
        ),
      };
      const nextRemote: FederationStatsSummaryAggregate = {
        ...(remoteSummaryEntry.value ?? this.emptySummaryAggregate()),
        denials: this.incrementDenials(
          remoteSummaryEntry.value?.denials ?? this.emptyDenials(),
          event.kind,
        ),
      };
      const committed = await this.kv
        .atomic()
        .check({ key: eventKey, versionstamp: eventEntry.versionstamp })
        .check({
          key: globalSummaryKey,
          versionstamp: globalSummaryEntry.versionstamp,
        })
        .check({
          key: remoteSummaryKey,
          versionstamp: remoteSummaryEntry.versionstamp,
        })
        .check({
          key: linkAggregateKey,
          versionstamp: linkEntry.versionstamp,
        })
        .set(eventKey, event)
        .set(globalSummaryKey, nextGlobal)
        .set(remoteSummaryKey, nextRemote)
        .set(linkAggregateKey, nextLink)
        .commit();
      if (committed.ok) return;
    }
    throw new Error("Failed to persist federation denial aggregate");
  }

  private async persistDeadLetterEntry(
    key: Deno.KvKey,
    entry: FederationDeadLetter,
  ): Promise<void> {
    const globalSummaryKey = this.summaryKey();
    const remoteSummaryKey = this.summaryKey(entry.remoteBrokerId);
    for (let attempt = 0; attempt < MAX_KV_UPDATE_RETRIES; attempt++) {
      const [deadLetterEntry, globalSummaryEntry, remoteSummaryEntry] =
        await Promise.all([
          this.kv.get<FederationDeadLetter>(key),
          this.kv.get<FederationStatsSummaryAggregate>(globalSummaryKey),
          this.kv.get<FederationStatsSummaryAggregate>(remoteSummaryKey),
        ]);
      if (deadLetterEntry.value) return;
      const nextGlobal = this.incrementDeadLetterBacklog(
        globalSummaryEntry.value,
      );
      const nextRemote = this.incrementDeadLetterBacklog(
        remoteSummaryEntry.value,
      );
      const committed = await this.kv
        .atomic()
        .check({ key, versionstamp: deadLetterEntry.versionstamp })
        .check({
          key: globalSummaryKey,
          versionstamp: globalSummaryEntry.versionstamp,
        })
        .check({
          key: remoteSummaryKey,
          versionstamp: remoteSummaryEntry.versionstamp,
        })
        .set(key, entry)
        .set(globalSummaryKey, nextGlobal)
        .set(remoteSummaryKey, nextRemote)
        .commit();
      if (committed.ok) return;
    }
    throw new Error("Failed to persist federation dead-letter aggregate");
  }

  private async readAggregatedFederationStats(
    remoteBrokerId?: string,
  ): Promise<FederationStatsSnapshot | null> {
    const summaryEntry = await this.kv.get<FederationStatsSummaryAggregate>(
      this.summaryKey(remoteBrokerId),
    );
    const links: FederationLinkStats[] = [];
    for await (
      const entry of this.kv.list<FederationLinkStatsAggregate>({
        prefix: this.linkPrefix(remoteBrokerId),
      })
    ) {
      if (!entry.value) continue;
      const { latencySamples: _latencySamples, ...link } = entry.value;
      links.push(link);
    }
    if (!summaryEntry.value && links.length === 0) {
      return null;
    }
    const summary = summaryEntry.value ?? this.emptySummaryAggregate();
    return {
      links,
      successCount: summary.successCount,
      errorCount: summary.errorCount,
      denials: summary.denials,
      deadLetterBacklog: summary.deadLetterBacklog,
    };
  }

  private async scanFederationStats(
    remoteBrokerId?: string,
  ): Promise<FederationStatsSnapshot> {
    const eventPrefix: Deno.KvKey = ["federation", "events"];
    const denialPrefix: Deno.KvKey = ["federation", "denials"];
    const byLink = new Map<string, FederationLinkStatsAggregate>();
    let successCount = 0;
    let errorCount = 0;
    const denials = this.emptyDenials();

    for await (
      const entry of this.kv.list<CrossBrokerHopEvent>({
        prefix: eventPrefix,
      })
    ) {
      const event = entry.value;
      if (!event) continue;
      if (remoteBrokerId && event.remoteBrokerId !== remoteBrokerId) continue;

      const existing = byLink.get(event.linkId) ??
        this.emptyLinkAggregate(event.remoteBrokerId, event.linkId);
      const latencySamples = [...existing.latencySamples, event.latencyMs];
      const link: FederationLinkStatsAggregate = {
        ...existing,
        successCount: existing.successCount + (event.success ? 1 : 0),
        errorCount: existing.errorCount +
          (!event.success && event.errorKind !== "auth" ? 1 : 0),
        p50LatencyMs: this.percentile(latencySamples, 50),
        p95LatencyMs: this.percentile(latencySamples, 95),
        latencySamples,
        lastTaskId: event.taskId,
        lastTraceId: event.traceId,
        lastOccurredAt: event.occurredAt,
      };
      if (event.success) {
        successCount += 1;
      } else if (event.errorKind !== "auth") {
        errorCount += 1;
      }
      byLink.set(event.linkId, link);
    }

    for await (
      const entry of this.kv.list<FederationDenialEvent>({
        prefix: denialPrefix,
      })
    ) {
      const event = entry.value;
      if (!event) continue;
      if (remoteBrokerId && event.remoteBrokerId !== remoteBrokerId) continue;

      const existing = byLink.get(event.linkId) ??
        this.emptyLinkAggregate(event.remoteBrokerId, event.linkId);
      const link: FederationLinkStatsAggregate = {
        ...existing,
        denials: this.incrementDenials(existing.denials, event.kind),
        lastTaskId: event.taskId,
        lastTraceId: event.traceId,
        lastOccurredAt: event.occurredAt,
      };
      byLink.set(event.linkId, link);
      switch (event.kind) {
        case "policy":
          denials.policy += 1;
          break;
        case "auth":
          denials.auth += 1;
          break;
        case "not_found":
          denials.notFound += 1;
          break;
      }
    }

    const deadLetters = await this.listDeadLetters(remoteBrokerId);
    const links = [...byLink.values()].map((entry) => {
      const { latencySamples: _latencySamples, ...link } = entry;
      return link;
    });

    return {
      links,
      successCount,
      errorCount,
      denials,
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
