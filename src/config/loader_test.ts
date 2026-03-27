import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createDefaultConfig, getConfigOrDefault, loadConfig, saveConfig } from "./loader.ts";
import { ConfigError } from "../shared/errors.ts";

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
