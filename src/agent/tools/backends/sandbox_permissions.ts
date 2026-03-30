import type {
  SandboxConfig,
  SandboxExecRequest,
  SandboxPermission,
  ToolResult,
} from "../../../shared/types.ts";

export interface PermissionIntersection {
  granted: SandboxPermission[];
  denied: SandboxPermission[];
}

/** Compute intersection: only permissions the tool needs AND the agent allows. */
export function computePermissionIntersection(
  toolPerms: SandboxPermission[],
  agentPerms: SandboxPermission[],
): PermissionIntersection {
  const granted: SandboxPermission[] = [];
  const denied: SandboxPermission[] = [];

  for (const perm of toolPerms) {
    if (agentPerms.includes(perm)) {
      granted.push(perm);
    } else {
      denied.push(perm);
    }
  }

  return { granted, denied };
}

export function createPermissionDeniedResult(
  req: SandboxExecRequest,
  sandboxConfig: SandboxConfig,
  denied: SandboxPermission[],
): ToolResult {
  return {
    success: false,
    output: "",
    error: {
      code: "SANDBOX_PERMISSION_DENIED",
      context: {
        tool: req.tool,
        required: req.permissions,
        agentAllowed: sandboxConfig.allowedPermissions,
        denied,
      },
      recovery: `Add ${
        denied.map((perm) => `'${perm}'`).join(", ")
      } to agent sandbox.allowedPermissions`,
    },
  };
}
