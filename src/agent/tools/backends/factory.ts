/**
 * Sandbox backend factory (ADR-010).
 *
 * Creates the appropriate SandboxBackend based on config.
 * No "auto" mode — backend is always explicit (AX #7).
 * Fail-closed: "cloud" without token = error.
 */

import type { SandboxConfig } from "../../../shared/types.ts";
import type { SandboxBackend } from "../../sandbox_types.ts";
import { getSandboxAccessToken } from "../../../shared/deploy_credentials.ts";
import { ToolError } from "../../../shared/errors.ts";
import { LocalProcessBackend } from "./local.ts";
import { DenoSandboxBackend } from "./cloud.ts";

export function createSandboxBackend(
  sandboxConfig: SandboxConfig,
): SandboxBackend {
  const backend = sandboxConfig.backend ?? "local";

  if (backend === "cloud") {
    const token = getSandboxAccessToken();
    if (!token) {
      throw new ToolError(
        "SANDBOX_UNAVAILABLE",
        { backend: "cloud", reason: "DENO_DEPLOY_ORG_TOKEN not set" },
        "Set DENO_DEPLOY_ORG_TOKEN or use backend: 'local'",
      );
    }
    return new DenoSandboxBackend(sandboxConfig, token);
  }

  return new LocalProcessBackend(sandboxConfig);
}
