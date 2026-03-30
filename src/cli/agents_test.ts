import { assertEquals } from "@std/assert";
import { WorkspaceLoader } from "../agent/workspace.ts";
import {
  createDefaultConfig,
  getPersistedConfigOrDefault,
  saveConfig,
} from "../config/mod.ts";
import { createAgent, deleteAgent } from "./agents.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

function withTempCliState(
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const tmpHome = await Deno.makeTempDir();
    const tmpAgents = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    const originalAgentsDir = Deno.env.get("DENOCLAW_AGENTS_DIR");

    Deno.env.set("HOME", tmpHome);
    Deno.env.set("DENOCLAW_AGENTS_DIR", tmpAgents);

    try {
      await fn();
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      if (originalAgentsDir) {
        Deno.env.set("DENOCLAW_AGENTS_DIR", originalAgentsDir);
      } else Deno.env.delete("DENOCLAW_AGENTS_DIR");
      try {
        await Deno.remove(tmpHome, { recursive: true });
      } catch {
        // ignore cleanup races
      }
      try {
        await Deno.remove(tmpAgents, { recursive: true });
      } catch {
        // ignore cleanup races
      }
    }
  };
}

Deno.test({
  name:
    "createAgent writes workspace state and clears matching legacy registry entry",
  fn: withTempCliState(async () => {
    const config = createDefaultConfig();
    config.agents.registry = {
      alice: {
        model: "legacy/model",
        sandbox: { allowedPermissions: ["read"] },
      },
    };
    await saveConfig(config, { persistAgentRegistry: true });

    await createAgent("alice", {
      description: "workspace agent",
      model: "gpt-5.4",
      permissions: "read,run",
      force: true,
    });

    const persisted = await getPersistedConfigOrDefault();
    assertEquals(persisted.agents.registry, undefined);

    const workspace = await WorkspaceLoader.load("alice");
    assertEquals(workspace?.entry.description, "workspace agent");
    assertEquals(workspace?.entry.model, "gpt-5.4");
    assertEquals(workspace?.entry.sandbox?.allowedPermissions, ["read", "run"]);
  }),
  ...testOpts,
});

Deno.test({
  name: "deleteAgent removes config-only legacy agents and cleans registry",
  fn: withTempCliState(async () => {
    const config = createDefaultConfig();
    config.agents.registry = {
      alice: {
        model: "legacy/model",
        sandbox: { allowedPermissions: ["read"] },
      },
      bob: {
        model: "legacy/peer",
        sandbox: { allowedPermissions: ["read", "run"] },
        peers: ["alice"],
        acceptFrom: ["alice"],
      },
    };
    await saveConfig(config, { persistAgentRegistry: true });

    await deleteAgent("alice", { yes: true });

    const persisted = await getPersistedConfigOrDefault();
    assertEquals(persisted.agents.registry?.alice, undefined);
    assertEquals(persisted.agents.registry?.bob?.peers, []);
    assertEquals(persisted.agents.registry?.bob?.acceptFrom, []);
  }),
  ...testOpts,
});
