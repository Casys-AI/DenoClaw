import { assertEquals } from "@std/assert";
import { syncCatalogIfTrusted } from "./tunnel_upgrade.ts";
import type { TunnelCapabilities } from "../types.ts";

const instanceCaps: TunnelCapabilities = {
  tunnelId: "broker-remote",
  type: "instance",
  tools: [],
  allowedAgents: [],
  agents: ["agent-1"],
};

Deno.test(
  "SEC-19: syncCatalogIfTrusted does NOT sync when getIdentity returns null",
  async () => {
    let syncCalled = false;
    const service = {
      getIdentity: (_brokerId: string) => Promise.resolve(null),
      syncCatalog: () => {
        syncCalled = true;
        return Promise.resolve();
      },
    };

    const result = await syncCatalogIfTrusted(
      service,
      "broker-remote",
      instanceCaps,
    );

    assertEquals(result, false);
    assertEquals(syncCalled, false);
  },
);

Deno.test(
  "SEC-19: syncCatalogIfTrusted syncs catalog when identity is trusted",
  async () => {
    let syncCalled = false;
    let syncedBrokerId = "";
    const service = {
      getIdentity: (_brokerId: string) =>
        Promise.resolve({
          brokerId: "broker-remote",
          instanceUrl: "https://broker-remote.example.com",
          publicKeys: ["key-1"],
          status: "trusted" as const,
        }),
      syncCatalog: (
        remoteBrokerId: string,
        _entries: unknown,
        _correlation: unknown,
      ) => {
        syncCalled = true;
        syncedBrokerId = remoteBrokerId;
        return Promise.resolve();
      },
    };

    const result = await syncCatalogIfTrusted(
      service,
      "broker-remote",
      instanceCaps,
    );

    assertEquals(result, true);
    assertEquals(syncCalled, true);
    assertEquals(syncedBrokerId, "broker-remote");
  },
);

Deno.test(
  "SEC-19: syncCatalogIfTrusted does NOT sync when identity status is not trusted",
  async () => {
    let syncCalled = false;
    const service = {
      getIdentity: (_brokerId: string) =>
        Promise.resolve({
          brokerId: "broker-remote",
          instanceUrl: "https://broker-remote.example.com",
          publicKeys: [],
          status: "pending" as const,
        }),
      syncCatalog: () => {
        syncCalled = true;
        return Promise.resolve();
      },
    };

    const result = await syncCatalogIfTrusted(
      service,
      "broker-remote",
      instanceCaps,
    );

    assertEquals(result, false);
    assertEquals(syncCalled, false);
  },
);
