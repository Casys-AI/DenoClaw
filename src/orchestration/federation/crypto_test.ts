import { assertEquals } from "@std/assert";
import {
  generateCatalogSigningKeyPair,
  signCatalogEnvelope,
  verifyCatalogEnvelopeSignature,
} from "./crypto.ts";

Deno.test("catalog envelope signatures verify with matching key", async () => {
  const keys = await generateCatalogSigningKeyPair();
  const envelope = await signCatalogEnvelope(
    {
      remoteBrokerId: "broker-b",
      schemaVersion: 1,
      signedAt: "2026-03-29T00:00:00.000Z",
      entries: [
        {
          remoteBrokerId: "broker-b",
          agentId: "agent-1",
          card: { name: "Agent One" },
          capabilities: ["shell", "chat"],
          visibility: "public",
        },
      ],
    },
    keys.privateKey,
  );

  const valid = await verifyCatalogEnvelopeSignature(envelope, [
    keys.publicKey,
  ]);
  assertEquals(valid, true);
});

Deno.test(
  "catalog envelope signatures fail with non-matching key",
  async () => {
    const signer = await generateCatalogSigningKeyPair();
    const verifier = await generateCatalogSigningKeyPair();
    const envelope = await signCatalogEnvelope(
      {
        remoteBrokerId: "broker-b",
        schemaVersion: 1,
        signedAt: "2026-03-29T00:00:00.000Z",
        entries: [
          {
            remoteBrokerId: "broker-b",
            agentId: "agent-1",
            card: { name: "Agent One" },
            capabilities: ["chat"],
            visibility: "public",
          },
        ],
      },
      signer.privateKey,
    );

    const valid = await verifyCatalogEnvelopeSignature(envelope, [
      verifier.publicKey,
    ]);
    assertEquals(valid, false);
  },
);

Deno.test(
  "catalog envelope signatures fail when payload is tampered",
  async () => {
    const keys = await generateCatalogSigningKeyPair();
    const envelope = await signCatalogEnvelope(
      {
        remoteBrokerId: "broker-b",
        schemaVersion: 1,
        signedAt: "2026-03-29T00:00:00.000Z",
        entries: [
          {
            remoteBrokerId: "broker-b",
            agentId: "agent-1",
            card: { nested: { model: "gpt-5" }, name: "Agent One" },
            capabilities: ["chat"],
            visibility: "public",
          },
        ],
      },
      keys.privateKey,
    );

    const valid = await verifyCatalogEnvelopeSignature(
      {
        ...envelope,
        entries: [
          {
            ...envelope.entries[0],
            card: { nested: { model: "gpt-5" }, name: "Tampered Agent" },
          },
        ],
      },
      [keys.publicKey],
    );
    assertEquals(valid, false);
  },
);
