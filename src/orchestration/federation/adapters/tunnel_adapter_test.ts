import { assertEquals } from "@std/assert";
import { mapInstanceTunnelToCatalog } from "./tunnel_adapter.ts";

Deno.test("mapInstanceTunnelToCatalog maps instance capabilities to catalog entries", () => {
  const entries = mapInstanceTunnelToCatalog("broker-remote", {
    tunnelId: "broker-remote",
    type: "instance",
    tools: ["shell", "fetch"],
    agents: ["agent-public", "agent-private"],
    allowedAgents: ["agent-public"],
  });

  assertEquals(entries.length, 2);
  assertEquals(entries[0].remoteBrokerId, "broker-remote");
  assertEquals(entries[0].visibility, "public");
  assertEquals(entries[1].visibility, "restricted");
  assertEquals(entries[0].capabilities, ["shell", "fetch"]);
});
