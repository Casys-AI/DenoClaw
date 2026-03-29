import type { SignedCatalogEnvelope } from "./types.ts";

function toBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
}

function canonicalCatalogPayload(envelope: SignedCatalogEnvelope): string {
  const entries = envelope.entries
    .map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities].sort(),
      card: Object.keys(entry.card)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = entry.card[key];
          return acc;
        }, {}),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  return JSON.stringify({
    remoteBrokerId: envelope.remoteBrokerId,
    schemaVersion: envelope.schemaVersion,
    signedAt: envelope.signedAt,
    keyId: envelope.keyId ?? null,
    entries,
  });
}

/**
 * Lightweight deterministic signing helper for federation catalog exchange.
 * It is intentionally transport-agnostic and can be replaced later by
 * asymmetric signatures without changing service methods.
 */
export async function signCatalogEnvelope(
  envelope: Omit<SignedCatalogEnvelope, "signature">,
  key: string,
): Promise<SignedCatalogEnvelope> {
  const payload = canonicalCatalogPayload({ ...envelope, signature: "" });
  const signature = await sha256(`${key}:${payload}`);
  return { ...envelope, signature };
}

export async function verifyCatalogEnvelopeSignature(
  envelope: SignedCatalogEnvelope,
  keys: string[],
): Promise<boolean> {
  for (const key of keys) {
    const payload = canonicalCatalogPayload(envelope);
    const computed = await sha256(`${key}:${payload}`);
    if (computed === envelope.signature) return true;
  }
  return false;
}
