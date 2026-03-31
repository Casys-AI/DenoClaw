import { assertEquals } from "@std/assert";
import { WorkspaceLoader } from "./workspace.ts";
import { getAgentConfigPath, getAgentSoulPath } from "../shared/helpers.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

function withTempAgentsDir(
  fn: (cleanup: () => Promise<void>) => Promise<void>,
) {
  return async () => {
    const tmpDir = await Deno.makeTempDir();
    const prev = Deno.env.get("DENOCLAW_AGENTS_DIR");
    Deno.env.set("DENOCLAW_AGENTS_DIR", tmpDir);
    try {
      await fn(async () => {
        Deno.env.delete("DENOCLAW_AGENTS_DIR");
        if (prev) Deno.env.set("DENOCLAW_AGENTS_DIR", prev);
        await Deno.remove(tmpDir, { recursive: true });
      });
    } finally {
      Deno.env.delete("DENOCLAW_AGENTS_DIR");
      if (prev) Deno.env.set("DENOCLAW_AGENTS_DIR", prev);
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ok */ }
    }
  };
}

Deno.test({
  name: "WorkspaceLoader.create creates agent.json and soul.md in project dir",
  fn: withTempAgentsDir(async () => {
    const id = `test-ws-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await WorkspaceLoader.create(id, {
        description: "test agent",
        sandbox: { allowedPermissions: ["read"] },
        peers: ["bob"],
      }, "You are a test agent.");

      const exists = await WorkspaceLoader.exists(id);
      assertEquals(exists, true);

      const configRaw = await Deno.readTextFile(getAgentConfigPath(id));
      const entry = JSON.parse(configRaw);
      assertEquals(entry.description, "test agent");
      assertEquals(entry.peers, ["bob"]);

      const soul = await Deno.readTextFile(getAgentSoulPath(id));
      assertEquals(soul, "You are a test agent.");
    } finally {
      await WorkspaceLoader.delete(id);
    }
  }),
  ...testOpts,
});

Deno.test({
  name: "WorkspaceLoader.load returns null for non-existent agent",
  fn: withTempAgentsDir(async () => {
    const ws = await WorkspaceLoader.load("does-not-exist-ever");
    assertEquals(ws, null);
  }),
  ...testOpts,
});

Deno.test({
  name: "WorkspaceLoader.load returns AgentWorkspace with all fields",
  fn: withTempAgentsDir(async () => {
    const id = `test-ws-load-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await WorkspaceLoader.create(id, {
        model: "test/model",
        sandbox: { allowedPermissions: ["read", "net"] },
      }, "Be helpful.");

      const ws = await WorkspaceLoader.load(id);
      assertEquals(ws?.agentId, id);
      assertEquals(ws?.entry.model, "test/model");
      assertEquals(ws?.systemPrompt, "Be helpful.");
      assertEquals(typeof ws?.memoryPath, "string");
    } finally {
      await WorkspaceLoader.delete(id);
    }
  }),
  ...testOpts,
});

Deno.test({
  name: "WorkspaceLoader.listAll and buildRegistry",
  fn: withTempAgentsDir(async () => {
    const id1 = `test-ws-list-a-${crypto.randomUUID().slice(0, 8)}`;
    const id2 = `test-ws-list-b-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await WorkspaceLoader.create(id1, {
        sandbox: { allowedPermissions: ["read"] },
      });
      await WorkspaceLoader.create(id2, {
        description: "second",
        sandbox: { allowedPermissions: [] },
      });

      const all = await WorkspaceLoader.listAll();
      assertEquals(all.includes(id1), true);
      assertEquals(all.includes(id2), true);

      const registry = await WorkspaceLoader.buildRegistry();
      assertEquals(id1 in registry, true);
      assertEquals(registry[id2].description, "second");
    } finally {
      await WorkspaceLoader.delete(id1);
      await WorkspaceLoader.delete(id2);
    }
  }),
  ...testOpts,
});

Deno.test({
  name: "WorkspaceLoader.delete removes workspace",
  fn: withTempAgentsDir(async () => {
    const id = `test-ws-del-${crypto.randomUUID().slice(0, 8)}`;
    await WorkspaceLoader.create(id, { sandbox: { allowedPermissions: [] } });
    assertEquals(await WorkspaceLoader.exists(id), true);

    await WorkspaceLoader.delete(id);
    assertEquals(await WorkspaceLoader.exists(id), false);
  }),
  ...testOpts,
});
