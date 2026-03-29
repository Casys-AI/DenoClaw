import { assertEquals, assertExists } from "@std/assert";
import { KvFederationAdapter } from "./kv_adapter.ts";

Deno.test("KvFederationAdapter link lifecycle", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    const link = await adapter.establishLink({
      localBrokerId: "broker-a",
      remoteBrokerId: "broker-b",
      requestedBy: "broker-a",
    });

    assertEquals(link.state, "active");
    const links = await adapter.listLinks();
    assertEquals(links.length, 1);

    await adapter.setLinkState(link.linkId, "failed");
    const failed = (await adapter.listLinks())[0];
    assertEquals(failed.state, "failed");

    await adapter.terminateLink(link.linkId);
    assertEquals((await adapter.listLinks()).length, 0);
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("KvFederationAdapter catalog lookup", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    await adapter.setRemoteCatalog("broker-b", [{
      remoteBrokerId: "broker-b",
      agentId: "agent-1",
      card: { name: "Agent 1" },
      capabilities: ["chat"],
      visibility: "public",
    }]);

    const card = await adapter.getRemoteAgentCard("broker-b", "agent-1");
    assertExists(card);
    assertEquals(card?.name, "Agent 1");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("KvFederationAdapter stores and reads route policy", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    await adapter.setRoutePolicy("broker-a", {
      policyId: "broker-a",
      preferLocal: true,
      preferredRemoteBrokerIds: ["broker-b"],
      denyAgentIds: ["agent-denied"],
      allowAgentIds: ["agent-allowed"],
      maxLatencyMs: 2000,
    });

    const policy = await adapter.getRoutePolicy("broker-a");
    assertExists(policy);
    assertEquals(policy?.preferredRemoteBrokerIds, ["broker-b"]);
    assertEquals(policy?.denyAgentIds, ["agent-denied"]);
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});


Deno.test("KvFederationAdapter identity lifecycle", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const adapter = new KvFederationAdapter(kv);
    await adapter.upsertIdentity({
      brokerId: "broker-a",
      instanceUrl: "https://broker-a.example.com",
      publicKeys: ["key-1"],
      status: "trusted",
    });

    const stored = await adapter.getIdentity("broker-a");
    assertExists(stored);
    assertEquals(stored?.status, "trusted");

    const all = await adapter.listIdentities();
    assertEquals(all.length, 1);

    await adapter.revokeIdentity("broker-a");
    const revoked = await adapter.getIdentity("broker-a");
    assertEquals(revoked?.status, "revoked");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
