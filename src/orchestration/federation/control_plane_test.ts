import { assertEquals } from "@std/assert";
import {
  createFederationControlRouter,
  isFederationControlMethod,
  type FederationControlEnvelope,
} from "./control_plane.ts";

Deno.test("federation control-plane method guard", () => {
  assertEquals(isFederationControlMethod("federation_link_open"), true);
  assertEquals(isFederationControlMethod("task_submit"), false);
});

Deno.test("federation control-plane router dispatches", async () => {
  const seen: string[] = [];
  const router = createFederationControlRouter({
    federation_link_open: async () => { seen.push("open"); },
    federation_link_ack: async () => { seen.push("ack"); },
    federation_catalog_sync: async () => { seen.push("sync"); },
    federation_route_probe: async () => { seen.push("probe"); },
    federation_link_close: async () => { seen.push("close"); },
  });

  const envelope: FederationControlEnvelope = {
    id: "control-1",
    from: "broker-a",
    type: "federation_catalog_sync",
    payload: { remoteBrokerId: "broker-b", agents: ["agent-1"] },
    timestamp: new Date().toISOString(),
  };

  await router(envelope);
  assertEquals(seen, ["sync"]);
});
