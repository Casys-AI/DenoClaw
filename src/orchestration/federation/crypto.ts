import type { SignedCatalogEnvelope } from "./types.ts";

const encoder = new TextEncoder();
const ECDSA_IMPORT_ALGORITHM: EcKeyImportParams = {
  name: "ECDSA",
  namedCurve: "P-256",
};
const ECDSA_SIGN_ALGORITHM: EcdsaParams = {
  name: "ECDSA",
  hash: "SHA-256",
};

function toBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(input: string): ArrayBuffer {
  const padded = `${input}${"=".repeat((4 - (input.length % 4)) % 4)}`
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

export async function sha256Base64Url(input: string): Promise<string> {
  const bytes = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return Object.keys(objectValue)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalizeValue(objectValue[key]);
        return acc;
      }, {});
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalCatalogPayload(envelope: SignedCatalogEnvelope): string {
  const entries = envelope.entries
    .map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities].sort(),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  return canonicalJson({
    remoteBrokerId: envelope.remoteBrokerId,
    schemaVersion: envelope.schemaVersion,
    signedAt: envelope.signedAt,
    keyId: envelope.keyId ?? null,
    entries,
  });
}

async function importPrivateCatalogKey(
  serializedKey: string,
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    JSON.parse(serializedKey),
    ECDSA_IMPORT_ALGORITHM,
    false,
    ["sign"],
  );
}

async function importPublicCatalogKey(
  serializedKey: string,
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    JSON.parse(serializedKey),
    ECDSA_IMPORT_ALGORITHM,
    false,
    ["verify"],
  );
}

export async function generateCatalogSigningKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = (await crypto.subtle.generateKey(ECDSA_IMPORT_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return {
    publicKey: JSON.stringify(publicKey),
    privateKey: JSON.stringify(privateKey),
  };
}

/**
 * Lightweight deterministic signing helper for federation catalog exchange.
 * It serializes keys as JWK JSON strings so public verification keys can be
 * stored in BrokerIdentity while signing stays private to the sender.
 */
export async function signCatalogEnvelope(
  envelope: Omit<SignedCatalogEnvelope, "signature">,
  privateKey: string,
): Promise<SignedCatalogEnvelope> {
  const payload = canonicalCatalogPayload({ ...envelope, signature: "" });
  const signer = await importPrivateCatalogKey(privateKey);
  const signatureBytes = await crypto.subtle.sign(
    ECDSA_SIGN_ALGORITHM,
    signer,
    encoder.encode(payload),
  );
  const signature = toBase64Url(new Uint8Array(signatureBytes));
  return { ...envelope, signature };
}

export async function verifyCatalogEnvelopeSignature(
  envelope: SignedCatalogEnvelope,
  keys: string[],
): Promise<boolean> {
  for (const key of keys) {
    try {
      const payload = canonicalCatalogPayload(envelope);
      const verifier = await importPublicCatalogKey(key);
      const verified = await crypto.subtle.verify(
        ECDSA_SIGN_ALGORITHM,
        verifier,
        fromBase64Url(envelope.signature),
        encoder.encode(payload),
      );
      if (verified) return true;
    } catch {
      continue;
    }
  }
  return false;
}
