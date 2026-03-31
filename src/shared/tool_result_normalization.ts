import type {
  SandboxPermission,
  StructuredError,
  ToolResult,
} from "./types.ts";
import type { AgentRuntimeCapabilities } from "./runtime_capabilities.ts";
import {
  formatPrivilegeElevationGrantResources,
  type PrivilegeElevationGrantResource,
} from "./privilege_elevation.ts";

export interface PrivilegeElevationRequiredOptions {
  tool: string;
  command?: string;
  binary?: string;
  requiredPermissions: SandboxPermission[];
  agentAllowed: SandboxPermission[];
  denied?: SandboxPermission[];
  suggestedGrants?: PrivilegeElevationGrantResource[];
  capabilities?: Pick<
    AgentRuntimeCapabilities,
    "version" | "fingerprint" | "sandbox"
  >;
  elevationAvailable?: boolean;
  elevationReason?: PrivilegeElevationReason;
  backendCode?: string;
}

export type PrivilegeElevationReason =
  | "no_channel"
  | "disabled_for_agent"
  | "broker_unsupported"
  | "expired";

export function createPrivilegeElevationRequiredError(
  options: PrivilegeElevationRequiredOptions,
): StructuredError {
  const denied = resolveDeniedPermissions(options);
  const grantSummary =
    options.suggestedGrants && options.suggestedGrants.length > 0
      ? formatPrivilegeElevationGrantResources(options.suggestedGrants)
      : denied.join(", ");
  const target = options.binary ?? options.tool;
  const elevationSupported =
    options.capabilities?.sandbox.privilegeElevation.supported ?? false;
  const elevationAvailable = options.elevationAvailable;
  const elevationReason = options.elevationReason;

  return {
    code: "PRIVILEGE_ELEVATION_REQUIRED",
    context: {
      tool: options.tool,
      ...(options.command ? { command: options.command } : {}),
      ...(options.binary ? { binary: options.binary } : {}),
      requiredPermissions: options.requiredPermissions,
      agentAllowed: options.agentAllowed,
      denied,
      ...(options.suggestedGrants
        ? { suggestedGrants: options.suggestedGrants }
        : {}),
      ...(options.capabilities
        ? {
          capabilitiesVersion: options.capabilities.version,
          capabilitiesFingerprint: options.capabilities.fingerprint,
          privilegeElevationSupported: elevationSupported,
          ...(typeof elevationAvailable === "boolean"
            ? { elevationAvailable }
            : {}),
          ...(elevationReason ? { elevationReason } : {}),
          privilegeElevationScopes: options.capabilities.sandbox
            .privilegeElevation.scopes,
          privilegeElevationRequestTimeoutSec: options.capabilities.sandbox
            .privilegeElevation.requestTimeoutSec,
          privilegeElevationSessionGrantTtlSec: options.capabilities.sandbox
            .privilegeElevation.sessionGrantTtlSec,
        }
        : {}),
      ...(options.backendCode ? { backendCode: options.backendCode } : {}),
    },
    recovery: elevationSupported
      ? elevationAvailable === false
        ? `Attach an elevation channel or update agent sandbox.allowedPermissions / broker policy to allow ${target} (${grantSummary})`
        : `Grant temporary privilege elevation for ${target} (${grantSummary}) or update agent sandbox.allowedPermissions / broker policy`
      : `Update agent sandbox.allowedPermissions or broker policy to allow ${target} (${grantSummary})`,
  };
}

export function createExecPolicyDeniedError(
  options: {
    command: string;
    binary: string;
    reason: string;
    recovery?: string;
    capabilities?: Pick<AgentRuntimeCapabilities, "version" | "fingerprint">;
    backendCode?: string;
  },
): StructuredError {
  return {
    code: "EXEC_POLICY_DENIED",
    context: {
      command: options.command,
      binary: options.binary,
      reason: options.reason,
      ...(options.capabilities
        ? {
          capabilitiesVersion: options.capabilities.version,
          capabilitiesFingerprint: options.capabilities.fingerprint,
        }
        : {}),
      ...(options.backendCode ? { backendCode: options.backendCode } : {}),
    },
    recovery: options.recovery ??
      `Update execPolicy for '${options.binary}' or use an allowed command`,
  };
}

export function normalizeAgentFacingToolResult(
  result: ToolResult,
  options: PrivilegeElevationRequiredOptions,
): ToolResult {
  if (result.success || !result.error) {
    return result;
  }

  if (result.error.code === "EXEC_DENIED") {
    const context = result.error.context ?? {};
    const command = typeof context.command === "string"
      ? context.command
      : options.tool;
    const binary = typeof context.binary === "string"
      ? context.binary
      : command;
    const reason = typeof context.reason === "string"
      ? context.reason
      : "denied";
    return {
      ...result,
      error: createExecPolicyDeniedError({
        command,
        binary,
        reason,
        recovery: result.error.recovery,
        capabilities: options.capabilities,
        backendCode: result.error.code,
      }),
    };
  }

  if (result.error.code !== "SANDBOX_PERMISSION_DENIED") {
    return result;
  }

  return {
    ...result,
    error: createPrivilegeElevationRequiredError({
      ...options,
      backendCode: options.backendCode ?? result.error.code,
    }),
  };
}

function resolveDeniedPermissions(
  options: PrivilegeElevationRequiredOptions,
): SandboxPermission[] {
  if (options.denied && options.denied.length > 0) {
    return [...options.denied];
  }

  return options.requiredPermissions.filter((permission) =>
    !options.agentAllowed.includes(permission)
  );
}
