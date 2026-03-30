import { assertEquals } from "@std/assert";
import {
  createFederationControlRouter,
  type FederationControlEnvelope,
  isFederationControlMethod,
} from "./control_plane.ts";

Deno.test("federation control-plane method guard", () => {
  assertEquals(isFederationControlMethod("federation_link_open"), true);
  assertEquals(isFederationControlMethod("task_submit"), false);
});

Deno.test("federation control-plane router dispatches", async () => {
  const seen: string[] = [];
  const router = createFederationControlRouter({
    federation_link_open: () => {
      seen.push("open");
      return Promise.resolve();
    },
    federation_link_ack: () => {
      seen.push("ack");
      return Promise.resolve();
    },
    federation_catalog_sync: () => {
      seen.push("sync");
      return Promise.resolve();
    },
    federation_route_probe: () => {
      seen.push("probe");
      return Promise.resolve();
    },
    federation_link_close: () => {
      seen.push("close");
      return Promise.resolve();
    },
  });

  const envelope: FederationControlEnvelope = {
    id: "control-1",
    from: "broker-a",
    type: "federation_catalog_sync",
    payload: {
      remoteBrokerId: "broker-b",
      agents: ["agent-1"],
      traceId: "trace-sync-1",
    },
    timestamp: new Date().toISOString(),
  };

  await router(envelope);
  assertEquals(seen, ["sync"]);
});
