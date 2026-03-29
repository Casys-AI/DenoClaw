import { assertEquals } from "@std/assert";
import { FederationService } from "./service.ts";
import { KvFederationAdapter } from "./adapters/kv_adapter.ts";

Deno.test("FederationService.probeRoute applies requester and remote policies", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    const adapter = new KvFederationAdapter(kv);
    const service = new FederationService(adapter, adapter, adapter);

    await adapter.setRemoteCatalog("broker-b", [{
      remoteBrokerId: "broker-b",
      agentId: "agent-1",
      card: {},
      capabilities: [],
      visibility: "public",
    }]);

    await adapter.setRoutePolicy("broker-a", {
      policyId: "broker-a",
      preferLocal: false,
      preferredRemoteBrokerIds: ["broker-b"],
      denyAgentIds: ["agent-denied-by-requester"],
      allowAgentIds: ["agent-1"],
    });

    await adapter.setRoutePolicy("broker-b", {
      policyId: "broker-b",
      preferLocal: false,
      preferredRemoteBrokerIds: ["broker-a"],
      denyAgentIds: ["agent-denied-by-remote"],
      allowAgentIds: ["agent-1", "agent-denied-by-remote"],
    });

    const accepted = await service.probeRoute({
      requesterBrokerId: "broker-a",
      remoteBrokerId: "broker-b",
      targetAgent: "agent-1",
    });
    assertEquals(accepted.accepted, true);
    assertEquals(accepted.reason, "route_available");

    const deniedByRequester = await service.probeRoute({
      requesterBrokerId: "broker-a",
      remoteBrokerId: "broker-b",
      targetAgent: "agent-denied-by-requester",
    });
    assertEquals(deniedByRequester.accepted, false);
    assertEquals(deniedByRequester.reason, "denied_by_policy");

    const deniedByRemote = await service.probeRoute({
      requesterBrokerId: "broker-a",
      remoteBrokerId: "broker-b",
      targetAgent: "agent-denied-by-remote",
    });
    assertEquals(deniedByRemote.accepted, false);
    assertEquals(deniedByRemote.reason, "denied_by_policy");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
