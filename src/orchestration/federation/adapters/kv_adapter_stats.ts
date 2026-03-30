import type {
  FederationDeadLetter,
  FederationDenialBreakdown,
  FederationLink,
  FederationLinkStats,
  FederationStatsSnapshot,
} from "../types.ts";
import type { CrossBrokerHopEvent, FederationDenialEvent } from "../ports.ts";
import {
  federationDeadLetterKey,
  federationDeadLetterPrefix,
  federationDenialEventKey,
  federationDenialPrefix,
  federationHopEventKey,
  federationHopEventPrefix,
  federationLinkStatsKey,
  federationLinkStatsPrefix,
  federationStatsSummaryKey,
} from "./kv_adapter_keys.ts";

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

export class KvFederationStatsStore {
  constructor(private readonly kv: Deno.Kv) {}

  async ensureLinkStatsAggregate(link: FederationLink): Promise<void> {
    await this.updateSummaryAggregate(undefined, (summary) => summary);
    await this.updateSummaryAggregate(
      link.remoteBrokerId,
      (summary) => summary,
    );
    await this.updateLinkAggregate(
      link.remoteBrokerId,
      link.linkId,
      (current) => ({
        ...current,
        lastOccurredAt: current.lastOccurredAt ?? link.lastHeartbeatAt,
      }),
    );
  }

  async recordCrossBrokerHop(event: CrossBrokerHopEvent): Promise<void> {
    const eventKey = federationHopEventKey(event.taskId);
    const globalSummaryKey = federationStatsSummaryKey();
    const remoteSummaryKey = federationStatsSummaryKey(event.remoteBrokerId);
    const linkAggregateKey = federationLinkStatsKey(
      event.remoteBrokerId,
      event.linkId,
    );

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
        successCount: (linkEntry.value?.successCount ?? 0) +
          (event.success ? 1 : 0),
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

  async recordFederationDenial(event: FederationDenialEvent): Promise<void> {
    const eventKey = federationDenialEventKey(event.remoteBrokerId);
    const globalSummaryKey = federationStatsSummaryKey();
    const remoteSummaryKey = federationStatsSummaryKey(event.remoteBrokerId);
    const linkAggregateKey = federationLinkStatsKey(
      event.remoteBrokerId,
      event.linkId,
    );

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

  async moveToDeadLetter(entry: FederationDeadLetter): Promise<void> {
    await this.persistDeadLetterEntry(
      federationDeadLetterKey(entry.remoteBrokerId, entry.deadLetterId),
      entry,
    );
  }

  async getDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<FederationDeadLetter | null> {
    const entry = await this.kv.get<FederationDeadLetter>(
      federationDeadLetterKey(remoteBrokerId, deadLetterId),
    );
    return entry.value ?? null;
  }

  async claimDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<FederationDeadLetter | null> {
    const key = federationDeadLetterKey(remoteBrokerId, deadLetterId);
    const globalSummaryKey = federationStatsSummaryKey();
    const remoteSummaryKey = federationStatsSummaryKey(remoteBrokerId);

    for (let attempt = 0; attempt < MAX_KV_UPDATE_RETRIES; attempt++) {
      const [deadLetterEntry, globalSummaryEntry, remoteSummaryEntry] =
        await Promise.all([
          this.kv.get<FederationDeadLetter>(key),
          this.kv.get<FederationStatsSummaryAggregate>(globalSummaryKey),
          this.kv.get<FederationStatsSummaryAggregate>(remoteSummaryKey),
        ]);
      if (!deadLetterEntry.value) return null;

      const nextGlobal = this.decrementDeadLetterBacklog(
        globalSummaryEntry.value,
      );
      const nextRemote = this.decrementDeadLetterBacklog(
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
        .delete(key)
        .set(globalSummaryKey, nextGlobal)
        .set(remoteSummaryKey, nextRemote)
        .commit();
      if (committed.ok) return deadLetterEntry.value;
    }

    throw new Error("Failed to claim federation dead-letter aggregate");
  }

  async listDeadLetters(
    remoteBrokerId?: string,
  ): Promise<FederationDeadLetter[]> {
    const entries: FederationDeadLetter[] = [];
    for await (
      const entry of this.kv.list<FederationDeadLetter>({
        prefix: federationDeadLetterPrefix(remoteBrokerId),
      })
    ) {
      if (entry.value) entries.push(entry.value);
    }
    return entries;
  }

  async getFederationStats(
    remoteBrokerId?: string,
  ): Promise<FederationStatsSnapshot> {
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

  private decrementDeadLetterBacklog(
    summary: FederationStatsSummaryAggregate | null | undefined,
  ): FederationStatsSummaryAggregate {
    const current = summary ?? this.emptySummaryAggregate();
    return {
      ...current,
      deadLetterBacklog: Math.max(0, current.deadLetterBacklog - 1),
    };
  }

  private async updateSummaryAggregate(
    remoteBrokerId: string | undefined,
    update: (
      current: FederationStatsSummaryAggregate,
    ) => FederationStatsSummaryAggregate,
  ): Promise<void> {
    await this.updateKvValue(
      federationStatsSummaryKey(remoteBrokerId),
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
    await this.updateKvValue(
      federationLinkStatsKey(remoteBrokerId, linkId),
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

    throw new Error(
      `Failed to update federation aggregate at ${key.join(":")}`,
    );
  }

  private async persistDeadLetterEntry(
    key: Deno.KvKey,
    entry: FederationDeadLetter,
  ): Promise<void> {
    const globalSummaryKey = federationStatsSummaryKey();
    const remoteSummaryKey = federationStatsSummaryKey(entry.remoteBrokerId);

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
      federationStatsSummaryKey(remoteBrokerId),
    );
    const links: FederationLinkStats[] = [];

    for await (
      const entry of this.kv.list<FederationLinkStatsAggregate>({
        prefix: federationLinkStatsPrefix(remoteBrokerId),
      })
    ) {
      if (!entry.value) continue;
      links.push(this.toLinkStats(entry.value));
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
    const byLink = new Map<string, FederationLinkStatsAggregate>();
    let successCount = 0;
    let errorCount = 0;
    const denials = this.emptyDenials();

    for await (
      const entry of this.kv.list<CrossBrokerHopEvent>({
        prefix: federationHopEventPrefix(),
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
        prefix: federationDenialPrefix(),
      })
    ) {
      const event = entry.value;
      if (!event) continue;
      if (remoteBrokerId && event.remoteBrokerId !== remoteBrokerId) continue;

      const existing = byLink.get(event.linkId) ??
        this.emptyLinkAggregate(event.remoteBrokerId, event.linkId);
      byLink.set(event.linkId, {
        ...existing,
        denials: this.incrementDenials(existing.denials, event.kind),
        lastTaskId: event.taskId,
        lastTraceId: event.traceId,
        lastOccurredAt: event.occurredAt,
      });

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

    return {
      links: [...byLink.values()].map((entry) => this.toLinkStats(entry)),
      successCount,
      errorCount,
      denials,
      deadLetterBacklog: (await this.listDeadLetters(remoteBrokerId)).length,
    };
  }

  private percentile(values: number[], pct: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((pct / 100) * sorted.length) - 1;
    const index = Math.min(Math.max(rank, 0), sorted.length - 1);
    return sorted[index];
  }

  private toLinkStats(
    entry: FederationLinkStatsAggregate,
  ): FederationLinkStats {
    const { latencySamples: _latencySamples, ...link } = entry;
    return link;
  }
}
