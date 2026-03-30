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
  const originalOrg = Deno.env.get("DENO_DEPLOY_ORG_TOKEN");
  const originalLegacy = Deno.env.get("DENO_DEPLOY_TOKEN");
  const originalSandbox = Deno.env.get("DENO_SANDBOX_API_TOKEN");
  try {
    Deno.env.delete("DENO_DEPLOY_ORG_TOKEN");
    Deno.env.delete("DENO_DEPLOY_TOKEN");
    Deno.env.delete("DENO_SANDBOX_API_TOKEN");
    assertThrows(
      () => createSandboxBackend({ ...baseSandbox, backend: "cloud" }),
      Error,
      "SANDBOX_UNAVAILABLE",
    );
  } finally {
    if (originalOrg) Deno.env.set("DENO_DEPLOY_ORG_TOKEN", originalOrg);
    if (originalLegacy) Deno.env.set("DENO_DEPLOY_TOKEN", originalLegacy);
    if (originalSandbox) {
      Deno.env.set("DENO_SANDBOX_API_TOKEN", originalSandbox);
    }
  }
});

Deno.test("createSandboxBackend accepts DENO_DEPLOY_ORG_TOKEN", () => {
  const originalOrg = Deno.env.get("DENO_DEPLOY_ORG_TOKEN");
  const originalLegacy = Deno.env.get("DENO_DEPLOY_TOKEN");
  const originalSandbox = Deno.env.get("DENO_SANDBOX_API_TOKEN");
  try {
    Deno.env.set("DENO_DEPLOY_ORG_TOKEN", "ddo_test");
    Deno.env.delete("DENO_DEPLOY_TOKEN");
    Deno.env.delete("DENO_SANDBOX_API_TOKEN");

    const backend = createSandboxBackend({ ...baseSandbox, backend: "cloud" });
    assertEquals(backend.kind, "cloud");
  } finally {
    if (originalOrg) Deno.env.set("DENO_DEPLOY_ORG_TOKEN", originalOrg);
    else Deno.env.delete("DENO_DEPLOY_ORG_TOKEN");
    if (originalLegacy) Deno.env.set("DENO_DEPLOY_TOKEN", originalLegacy);
    if (originalSandbox) {
      Deno.env.set("DENO_SANDBOX_API_TOKEN", originalSandbox);
    } else {
      Deno.env.delete("DENO_SANDBOX_API_TOKEN");
    }
  }
});
