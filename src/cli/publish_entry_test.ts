import { assertEquals } from "@std/assert";
import { materializePublishedEntry } from "./publish_entry.ts";

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
        approvalTimeoutSec: 30,
      },
    },
  );

  assertEquals(entry.sandbox, {
    allowedPermissions: ["read"],
    maxDurationSec: 20,
    approvalTimeoutSec: 30,
  });
});
