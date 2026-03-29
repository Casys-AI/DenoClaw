import type {
  BrokerIdentity,
  FederatedRoutePolicy,
  FederationLink,
  FederationLinkState,
  RemoteAgentCatalogEntry,
} from "../types.ts";
import type {
  CrossBrokerHopEvent,
  EstablishFederationLinkInput,
  FederationControlPort,
  FederationDiscoveryPort,
  FederationIdentityPort,
  FederationObservabilityPort,
  FederationPolicyPort,
} from "../ports.ts";

export class KvFederationAdapter
  implements
    FederationControlPort,
    FederationDiscoveryPort,
    FederationPolicyPort,
    FederationIdentityPort,
    FederationObservabilityPort {
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
  }

  async streamFederationEvents(
    _onEvent: (event: CrossBrokerHopEvent) => void,
  ): Promise<() => void> {
    return () => {};
  }
}
