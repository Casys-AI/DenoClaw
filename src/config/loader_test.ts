import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createDefaultConfig,
  getConfigOrDefault,
  getPersistedConfigOrDefault,
  loadConfig,
  saveConfig,
} from "./loader.ts";
import { ConfigError } from "../shared/errors.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";

Deno.test("createDefaultConfig returns valid config", () => {
  const config = createDefaultConfig();
  assertEquals(config.agents.defaults.model, "anthropic/claude-sonnet-4-6");
  assertEquals(config.agents.defaults.temperature, 0.7);
  assertEquals(config.agents.defaults.maxTokens, 4096);
  assertEquals(config.tools.restrictToWorkspace, false);
});

Deno.test("loadConfig throws ConfigError when file missing", async () => {
  const originalHome = Deno.env.get("HOME");
  Deno.env.set("HOME", "/tmp/denoclaw-test-nonexistent");
  try {
    await assertRejects(() => loadConfig(), ConfigError);
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
  }
});

Deno.test({
  name: "saveConfig + loadConfig roundtrip",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = createDefaultConfig();
      config.providers.anthropic = { apiKey: "test-key" };
      await saveConfig(config);

      const loaded = await loadConfig();
      assertEquals(loaded.agents.defaults.model, "anthropic/claude-sonnet-4-6");
      assertEquals(loaded.providers.anthropic?.apiKey, "test-key");
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "saveConfig strips derived agent registry by default",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = createDefaultConfig();
      config.agents.registry = {
        alice: { model: "gpt-5.4", sandbox: { allowedPermissions: ["read"] } },
      };

      await saveConfig(config);

      const loaded = await loadConfig();
      assertEquals(loaded.agents.registry, undefined);
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "saveConfig can persist legacy agent registry when requested",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = createDefaultConfig();
      config.agents.registry = {
        alice: { model: "gpt-5.4", sandbox: { allowedPermissions: ["read"] } },
      };

      await saveConfig(config, { persistAgentRegistry: true });

      const loaded = await getPersistedConfigOrDefault();
      assertEquals(loaded.agents.registry?.alice?.model, "gpt-5.4");
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "getConfigOrDefault returns defaults when no config",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = await getConfigOrDefault();
      assertEquals(config.agents.defaults.model, "anthropic/claude-sonnet-4-6");
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "getConfigOrDefault merges legacy registry with workspace agents",
  async fn() {
    const tmpHome = await Deno.makeTempDir();
    const tmpAgents = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    const originalAgentsDir = Deno.env.get("DENOCLAW_AGENTS_DIR");
    Deno.env.set("HOME", tmpHome);
    Deno.env.set("DENOCLAW_AGENTS_DIR", tmpAgents);

    try {
      const config = createDefaultConfig();
      config.agents.registry = {
        legacy: {
          model: "legacy/model",
          sandbox: { allowedPermissions: ["read"] },
        },
        shared: {
          model: "legacy/old",
          sandbox: { allowedPermissions: ["read"] },
        },
      };
      await saveConfig(config, { persistAgentRegistry: true });

      await WorkspaceLoader.create("workspace", {
        model: "workspace/model",
        sandbox: { allowedPermissions: ["read", "run"] },
      });
      await WorkspaceLoader.create("shared", {
        model: "workspace/wins",
        sandbox: { allowedPermissions: ["net"] },
      }, "system prompt");

      const resolved = await getConfigOrDefault();
      assertEquals(resolved.agents.registry?.legacy?.model, "legacy/model");
      assertEquals(
        resolved.agents.registry?.workspace?.model,
        "workspace/model",
      );
      assertEquals(resolved.agents.registry?.shared?.model, "workspace/wins");
      assertEquals(
        resolved.agents.registry?.shared?.systemPrompt,
        "system prompt",
      );
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      if (originalAgentsDir) {
        Deno.env.set("DENOCLAW_AGENTS_DIR", originalAgentsDir);
      } else Deno.env.delete("DENOCLAW_AGENTS_DIR");
      await Deno.remove(tmpHome, { recursive: true });
      await Deno.remove(tmpAgents, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "loadConfig rejects legacy telegram root fields outside accounts[]",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const configDir = `${tmpDir}/.denoclaw`;
      const configPath = `${configDir}/config.json`;
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          providers: {},
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-6",
              temperature: 0.7,
              maxTokens: 4096,
            },
          },
          tools: { restrictToWorkspace: false },
          channels: {
            telegram: {
              enabled: true,
              tokenEnvVar: "TG_PRIMARY_TOKEN",
              allowFrom: ["123", "456"],
            },
          },
        }),
      );

      await assertRejects(
        () => loadConfig(),
        ConfigError,
        "Move Telegram bot settings under channels.telegram.accounts[]",
      );
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "getConfigOrDefault does not swallow invalid channel config",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const configDir = `${tmpDir}/.denoclaw`;
      const configPath = `${configDir}/config.json`;
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          providers: {},
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-6",
              temperature: 0.7,
              maxTokens: 4096,
            },
          },
          tools: { restrictToWorkspace: false },
          channels: {
            telegram: {
              enabled: true,
              tokenEnvVar: "TG_PRIMARY_TOKEN",
            },
          },
        }),
      );

      await assertRejects(
        () => getConfigOrDefault(),
        ConfigError,
        "Move Telegram bot settings under channels.telegram.accounts[]",
      );
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "loadConfig and saveConfig preserve canonical telegram accounts[]",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = createDefaultConfig();
      config.channels.telegram = {
        enabled: true,
        accounts: [
          {
            accountId: "support-bot",
            tokenEnvVar: "TG_SUPPORT_TOKEN",
            allowFrom: ["123", "456"],
          },
        ],
      };

      await saveConfig(config);

      const loaded = await loadConfig();
      assertEquals(loaded.channels.telegram, {
        enabled: true,
        accounts: [
          {
            accountId: "support-bot",
            tokenEnvVar: "TG_SUPPORT_TOKEN",
            allowFrom: ["123", "456"],
          },
        ],
      });
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "loadConfig and saveConfig preserve canonical discord accounts[]",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const config = createDefaultConfig();
      config.channels.discord = {
        enabled: true,
        accounts: [
          {
            accountId: "ops-bot",
            tokenEnvVar: "DISCORD_OPS_TOKEN",
            allowFrom: ["123", "456"],
          },
        ],
      };

      await saveConfig(config);

      const loaded = await loadConfig();
      assertEquals(loaded.channels.discord, {
        enabled: true,
        accounts: [
          {
            accountId: "ops-bot",
            tokenEnvVar: "DISCORD_OPS_TOKEN",
            allowFrom: ["123", "456"],
          },
        ],
      });
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "loadConfig strips legacy agent channel routing fields from registry entries",
  async fn() {
    const tmpDir = await Deno.makeTempDir();
    const originalHome = Deno.env.get("HOME");
    Deno.env.set("HOME", tmpDir);

    try {
      const configDir = `${tmpDir}/.denoclaw`;
      const configPath = `${configDir}/config.json`;
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          providers: {},
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-6",
              temperature: 0.7,
              maxTokens: 4096,
            },
            registry: {
              legacy: {
                sandbox: { allowedPermissions: ["read"] },
                channels: ["telegram"],
                channelRouting: "broadcast",
              },
            },
          },
          tools: { restrictToWorkspace: false },
          channels: {},
        }),
      );

      const loaded = await loadConfig();
      assertEquals(loaded.agents.registry?.legacy, {
        sandbox: { allowedPermissions: ["read"] },
      });
    } finally {
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test("env vars override config providers", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  const originalKey = Deno.env.get("ANTHROPIC_API_KEY");

  Deno.env.set("HOME", tmpDir);
  Deno.env.set("ANTHROPIC_API_KEY", "from-env");

  try {
    const config = await getConfigOrDefault();
    assertStringIncludes(config.providers.anthropic?.apiKey || "", "from-env");
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    if (originalKey) Deno.env.set("ANTHROPIC_API_KEY", originalKey);
    else Deno.env.delete("ANTHROPIC_API_KEY");
    await Deno.remove(tmpDir, { recursive: true });
  }
});
