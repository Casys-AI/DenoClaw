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
  FederationDenialEvent,
  FederationDiscoveryPort,
  FederationEvent,
  FederationIdentityPort,
  FederationMetricsPort,
  FederationObservabilityPort,
  FederationPolicyPort,
} from "../ports.ts";
import {
  federationCatalogKey,
  federationIdentityKey,
  federationIdentityPrefix,
  federationLinkKey,
  federationLinksPrefix,
  federationPolicyKey,
  federationSessionKey,
  federationSubmissionKey,
} from "./kv_adapter_keys.ts";
import { KvFederationStatsStore } from "./kv_adapter_stats.ts";

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
  private readonly statsStore: KvFederationStatsStore;

  constructor(private readonly kv: Deno.Kv) {
    this.statsStore = new KvFederationStatsStore(kv);
  }

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
    await this.kv.set(federationLinkKey(link.linkId), link);
    await this.statsStore.ensureLinkStatsAggregate(link);
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
    await this.kv.delete(federationLinkKey(linkId));
  }

  async listLinks(): Promise<FederationLink[]> {
    const links: FederationLink[] = [];
    for await (
      const entry of this.kv.list<FederationLink>({
        prefix: federationLinksPrefix(),
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

    const link = await this.kv.get<FederationLink>(federationLinkKey(linkId));
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
      federationSessionKey(linkId, session.sessionId),
      session,
    );
    return session;
  }

  async refreshTrust(
    remoteBrokerId: string,
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<BrokerIdentity> {
    const identity: BrokerIdentity = {
      brokerId: remoteBrokerId,
      instanceUrl: "",
      publicKeys: [],
      status: "pending",
    };
    await this.upsertIdentity(identity);
    return identity;
  }

  async listRemoteAgents(
    remoteBrokerId: string,
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<RemoteAgentCatalogEntry[]> {
    const entry = await this.kv.get<RemoteAgentCatalogEntry[]>(
      federationCatalogKey(remoteBrokerId),
    );
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
    await this.kv.set(federationCatalogKey(remoteBrokerId), entries);
  }

  async upsertIdentity(
    identity: BrokerIdentity,
    _correlation?: FederationTraceContext,
  ): Promise<void> {
    await this.kv.set(federationIdentityKey(identity.brokerId), identity);
  }

  async getIdentity(
    brokerId: string,
    _correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity | null> {
    const entry = await this.kv.get<BrokerIdentity>(
      federationIdentityKey(brokerId),
    );
    return entry.value ?? null;
  }

  async listIdentities(
    _correlation?: FederationTraceContext,
  ): Promise<BrokerIdentity[]> {
    const identities: BrokerIdentity[] = [];
    for await (
      const entry of this.kv.list<BrokerIdentity>({
        prefix: federationIdentityPrefix(),
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
    await this.kv.set(federationPolicyKey(brokerId), policy);
  }

  async getRoutePolicy(
    brokerId: string,
    _correlation: FederationBrokerCorrelationContext,
  ): Promise<FederatedRoutePolicy | null> {
    const entry = await this.kv.get<FederatedRoutePolicy>(
      federationPolicyKey(brokerId),
    );
    return entry.value ?? null;
  }

  async setLinkState(
    linkId: string,
    state: FederationLinkState,
    _correlation: FederationLinkCorrelationContext,
  ): Promise<void> {
    const entry = await this.kv.get<FederationLink>(federationLinkKey(linkId));
    if (!entry.value) return;
    await this.kv.set(federationLinkKey(linkId), {
      ...entry.value,
      state,
      lastHeartbeatAt: new Date().toISOString(),
    });
  }

  async recordCrossBrokerHop(event: CrossBrokerHopEvent): Promise<void> {
    await this.statsStore.recordCrossBrokerHop(event);
    this.emitFederationEvent(event);
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
    await this.statsStore.recordFederationDenial(event);
    this.emitFederationEvent(event);
  }

  async createSubmissionRecord(
    record: FederatedSubmissionRecord,
    _correlation: FederationCorrelationContext,
  ): Promise<boolean> {
    const key = federationSubmissionKey(record.idempotencyKey);
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
    const entry = await this.kv.get<FederatedSubmissionRecord>(
      federationSubmissionKey(idempotencyKey),
    );
    return entry.value ?? null;
  }

  async upsertSubmissionRecord(
    record: FederatedSubmissionRecord,
    _correlation: FederationCorrelationContext,
  ): Promise<void> {
    await this.kv.set(federationSubmissionKey(record.idempotencyKey), record);
  }

  async moveToDeadLetter(
    entry: FederationDeadLetter,
    _correlation: FederationCorrelationContext,
  ): Promise<void> {
    await this.statsStore.moveToDeadLetter(entry);
  }

  async deleteSubmissionRecord(
    idempotencyKey: string,
    _correlation: FederationCorrelationContext,
  ): Promise<void> {
    await this.kv.delete(federationSubmissionKey(idempotencyKey));
  }

  async getDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<FederationDeadLetter | null> {
    return await this.statsStore.getDeadLetter(remoteBrokerId, deadLetterId);
  }

  async claimDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<FederationDeadLetter | null> {
    return await this.statsStore.claimDeadLetter(remoteBrokerId, deadLetterId);
  }

  async deleteDeadLetter(
    remoteBrokerId: string,
    deadLetterId: string,
  ): Promise<void> {
    await this.statsStore.claimDeadLetter(remoteBrokerId, deadLetterId);
  }

  async listDeadLetters(
    remoteBrokerId?: string,
  ): Promise<FederationDeadLetter[]> {
    return await this.statsStore.listDeadLetters(remoteBrokerId);
  }

  async getFederationStats(
    remoteBrokerId?: string,
  ): Promise<FederationStatsSnapshot> {
    return await this.statsStore.getFederationStats(remoteBrokerId);
  }

  private emitFederationEvent(event: FederationEvent): void {
    for (const subscriber of this.federationEventSubscribers.values()) {
      subscriber(event);
    }
  }
}
