import { assertEquals } from "@std/assert";
import {
  createBrokerOwnedAgentConfig,
  generateAgentEntrypoint,
  materializePublishedEntry,
} from "./publish_entry.ts";

Deno.test("materializePublishedEntry fills missing model defaults", () => {
  const entry = materializePublishedEntry(
    {
      systemPrompt: "agent prompt",
    },
    {
      model: "test/model",
      temperature: 0.2,
      maxTokens: 256,
      systemPrompt: "default prompt",
    },
  );

  assertEquals(entry, {
    model: "test/model",
    temperature: 0.2,
    maxTokens: 256,
    systemPrompt: "agent prompt",
  });
});

Deno.test("materializePublishedEntry preserves explicit sandbox permissions", () => {
  const entry = materializePublishedEntry(
    {
      sandbox: {
        allowedPermissions: ["read"],
        maxDurationSec: 20,
      },
    },
    {
      model: "test/model",
      temperature: 0.2,
      maxTokens: 256,
      sandbox: {
        allowedPermissions: ["read", "write"],
      },
    },
  );

  assertEquals(entry.sandbox, {
    allowedPermissions: ["read"],
    maxDurationSec: 20,
  });
});

Deno.test("materializePublishedEntry merges nested privilege elevation config", () => {
  const entry = materializePublishedEntry(
    {
      sandbox: {
        allowedPermissions: ["read"],
        privilegeElevation: {
          enabled: false,
        },
      },
    },
    {
      model: "test/model",
      temperature: 0.2,
      maxTokens: 256,
      sandbox: {
        allowedPermissions: ["read", "write"],
        privilegeElevation: {
          enabled: true,
          scopes: ["task", "session"],
        },
      },
    },
  );

  assertEquals(entry.sandbox?.privilegeElevation, {
    enabled: false,
    scopes: ["task", "session"],
  });
});

Deno.test("createBrokerOwnedAgentConfig strips workspace system prompt", () => {
  const entry = createBrokerOwnedAgentConfig({
    model: "test/model",
    systemPrompt: "workspace prompt",
    peers: ["agent-beta"],
  });

  assertEquals(entry, {
    model: "test/model",
    peers: ["agent-beta"],
  });
});

Deno.test("generateAgentEntrypoint embeds workspace snapshot when present", () => {
  const entrypoint = generateAgentEntrypoint("alice", {
    syncId: "sync-1",
    syncMode: "preserve",
    files: [{ path: "skills/test.md", content: "hello" }],
  });

  assertEquals(
    entrypoint.includes('"workspaceSnapshot"'),
    true,
  );
  assertEquals(
    entrypoint.includes('"agentId": "alice"'),
    true,
  );
  assertEquals(entrypoint.includes('"entry"'), false);
});
