/**
 * Sandbox backend factory (ADR-010).
 *
 * Creates the appropriate SandboxBackend based on config.
 * No "auto" mode — backend is always explicit (AX #7).
 * Fail-closed: "cloud" without token = error.
 */

import type { SandboxBackend, SandboxConfig } from "../../../shared/mod.ts";
import { ToolError } from "../../../shared/errors.ts";
import { LocalProcessBackend } from "./local.ts";
import { DenoSandboxBackend } from "./cloud.ts";

export function createSandboxBackend(
  sandboxConfig: SandboxConfig,
): SandboxBackend {
  const backend = sandboxConfig.backend ?? "local";

  if (backend === "cloud") {
    const token = Deno.env.get("DENO_DEPLOY_TOKEN");
    if (!token) {
      throw new ToolError(
        "SANDBOX_UNAVAILABLE",
        { backend: "cloud", reason: "DENO_DEPLOY_TOKEN not set" },
        "Set DENO_DEPLOY_TOKEN or use backend: 'local'",
      );
    }
    return new DenoSandboxBackend(sandboxConfig, token);
  }

  return new LocalProcessBackend(sandboxConfig);
}
