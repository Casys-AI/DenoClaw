import { assertEquals, assertThrows } from "@std/assert";
import { createSandboxBackend } from "./factory.ts";
import { LocalProcessBackend } from "./local.ts";
import type { SandboxConfig } from "../../../shared/types.ts";

const baseSandbox: SandboxConfig = {
  allowedPermissions: ["read", "run"],
};

Deno.test("createSandboxBackend defaults to local when backend omitted", () => {
  const backend = createSandboxBackend(baseSandbox);
  assertEquals(backend.kind, "local");
});

Deno.test("createSandboxBackend returns local when backend=local", () => {
  const backend = createSandboxBackend({ ...baseSandbox, backend: "local" });
  assertEquals(backend.kind, "local");
  assertEquals(backend instanceof LocalProcessBackend, true);
});

Deno.test("createSandboxBackend fail-closed — cloud without token throws ToolError", () => {
  const original = Deno.env.get("DENO_DEPLOY_TOKEN");
  try {
    Deno.env.delete("DENO_DEPLOY_TOKEN");
    assertThrows(
      () => createSandboxBackend({ ...baseSandbox, backend: "cloud" }),
      Error,
      "SANDBOX_UNAVAILABLE",
    );
  } finally {
    if (original) Deno.env.set("DENO_DEPLOY_TOKEN", original);
  }
});
