import { assertEquals, assertRejects } from "@std/assert";
import { DenoClawError } from "../../shared/errors.ts";
import {
  getPrivilegeElevationGrantSignature,
  type PrivilegeElevationGrant,
} from "../../shared/privilege_elevation.ts";
import { createLegacyAgentConfigKey } from "../agent_store.ts";
import { BrokerTaskPersistence } from "./persistence.ts";

Deno.test(
  "BrokerTaskPersistence appends session-scoped privilege grants atomically under concurrency",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const persistence = new BrokerTaskPersistence({
        getKv: () => Promise.resolve(kv),
      });
      const grants: PrivilegeElevationGrant[] = Array.from(
        { length: 16 },
        (_, index) => ({
          kind: "privilege-elevation",
          scope: "session",
          grants: [{
            permission: "write",
            paths: [`docs/note-${index}.md`],
          }],
          grantedAt: new Date(1_700_000_000_000 + index).toISOString(),
          source: "broker-resume",
        }),
      );

      await Promise.all(
        grants.map((grant) =>
          persistence.appendContextPrivilegeElevationGrant(
            "agent-beta",
            "ctx-concurrent",
            grant,
          )
        ),
      );

      const stored = await persistence.getContextPrivilegeElevationGrants(
        "agent-beta",
        "ctx-concurrent",
      );

      assertEquals(stored.length, grants.length);
      assertEquals(
        new Set(stored.map(getPrivilegeElevationGrantSignature)),
        new Set(grants.map(getPrivilegeElevationGrantSignature)),
      );
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerTaskPersistence.assertPeerAccess falls back to legacy agent config namespace",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const persistence = new BrokerTaskPersistence({
        getKv: () => Promise.resolve(kv),
      });

      await kv.set(createLegacyAgentConfigKey("agent-alpha"), {
        model: "test/model",
        peers: ["agent-beta"],
      });
      await kv.set(createLegacyAgentConfigKey("agent-beta"), {
        model: "test/model",
        acceptFrom: ["agent-alpha"],
      });

      await persistence.assertPeerAccess("agent-alpha", "agent-beta");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerTaskPersistence.assertPeerAccess keeps structured denial with legacy fallback",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const persistence = new BrokerTaskPersistence({
        getKv: () => Promise.resolve(kv),
      });

      await kv.set(createLegacyAgentConfigKey("agent-alpha"), {
        model: "test/model",
        peers: [],
      });
      await kv.set(createLegacyAgentConfigKey("agent-beta"), {
        model: "test/model",
        acceptFrom: ["agent-alpha"],
      });

      await assertRejects(
        () => persistence.assertPeerAccess("agent-alpha", "agent-beta"),
        DenoClawError,
        'Add "agent-beta" to agent-alpha.peers',
      );
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);
