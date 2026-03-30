import { verifyCatalogEnvelopeSignature } from "./crypto.ts";
import type {
  FederationDiscoveryPort,
  FederationIdentityPort,
} from "./ports.ts";
import type { BrokerIdentity, SignedCatalogEnvelope } from "./types.ts";

export interface FederationIdentityManagerDeps {
  discovery: FederationDiscoveryPort;
  identity: FederationIdentityPort;
}

export class FederationIdentityManager {
  constructor(private readonly deps: FederationIdentityManagerDeps) {}

  async syncSignedCatalog(envelope: SignedCatalogEnvelope): Promise<void> {
    const traceId = crypto.randomUUID();
    const identity = await this.deps.identity.getIdentity(
      envelope.remoteBrokerId,
      { traceId },
    );
    if (!identity || identity.status !== "trusted") {
      throw new Error(
        `Federation identity is not trusted for broker ${envelope.remoteBrokerId}`,
      );
    }

    const signatureValid = await verifyCatalogEnvelopeSignature(
      envelope,
      identity.publicKeys,
    );
    if (!signatureValid) {
      throw new Error(
        `Invalid catalog signature for broker ${envelope.remoteBrokerId}`,
      );
    }

    await this.deps.discovery.setRemoteCatalog(
      envelope.remoteBrokerId,
      envelope.entries,
      {
        remoteBrokerId: envelope.remoteBrokerId,
        traceId,
      },
    );
  }

  async upsertIdentity(identity: BrokerIdentity): Promise<void> {
    await this.deps.identity.upsertIdentity(identity, {
      traceId: crypto.randomUUID(),
    });
  }

  async revokeIdentity(brokerId: string): Promise<void> {
    await this.deps.identity.revokeIdentity(brokerId, {
      traceId: crypto.randomUUID(),
    });
  }

  async rotateIdentityKey(
    brokerId: string,
    nextPublicKey: string,
  ): Promise<BrokerIdentity> {
    return await this.deps.identity.rotateIdentityKey(
      brokerId,
      nextPublicKey,
      { traceId: crypto.randomUUID() },
    );
  }

  async getIdentity(brokerId: string): Promise<BrokerIdentity | null> {
    return await this.deps.identity.getIdentity(brokerId, {
      traceId: crypto.randomUUID(),
    });
  }

  async listIdentities(): Promise<BrokerIdentity[]> {
    return await this.deps.identity.listIdentities({
      traceId: crypto.randomUUID(),
    });
  }
}
