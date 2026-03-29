import { assertEquals } from "@std/assert";
import {
  signCatalogEnvelope,
  verifyCatalogEnvelopeSignature,
} from "./crypto.ts";

Deno.test("catalog envelope signatures verify with matching key", async () => {
  const envelope = await signCatalogEnvelope({
    remoteBrokerId: "broker-b",
    schemaVersion: 1,
    signedAt: "2026-03-29T00:00:00.000Z",
    entries: [{
      remoteBrokerId: "broker-b",
      agentId: "agent-1",
      card: { name: "Agent One" },
      capabilities: ["shell", "chat"],
      visibility: "public",
    }],
  }, "key-a");

  const valid = await verifyCatalogEnvelopeSignature(envelope, ["key-a"]);
  assertEquals(valid, true);
});

Deno.test("catalog envelope signatures fail with non-matching key", async () => {
  const envelope = await signCatalogEnvelope({
    remoteBrokerId: "broker-b",
    schemaVersion: 1,
    signedAt: "2026-03-29T00:00:00.000Z",
    entries: [{
      remoteBrokerId: "broker-b",
      agentId: "agent-1",
      card: { name: "Agent One" },
      capabilities: ["chat"],
      visibility: "public",
    }],
  }, "key-a");

  const valid = await verifyCatalogEnvelopeSignature(envelope, ["key-b"]);
  assertEquals(valid, false);
});
