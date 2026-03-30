/**
 * LocalProcessBackend — subprocess sandbox for local/dev mode (ADR-010).
 *
 * Spawns tool_executor.ts in a Deno subprocess with --allow-* flags
 * from ADR-005 permission intersection. Exec policy is enforced HERE,
 * before the subprocess is spawned.
 */

import type {
  SandboxBackend,
  SandboxConfig,
  SandboxExecRequest,
  ToolResult,
} from "../../../shared/types.ts";
import { LocalExecPolicyRuntime } from "./local_exec_policy.ts";
import {
  computePermissionIntersection,
  createPermissionDeniedResult,
} from "./sandbox_permissions.ts";
import { runLocalToolExecutor } from "./local_process_runner.ts";

export class LocalProcessBackend implements SandboxBackend {
  readonly kind = "local" as const;
  readonly supportsFullShell = false;

  private sandboxConfig: SandboxConfig;
  private execPolicyRuntime: LocalExecPolicyRuntime;

  constructor(sandboxConfig: SandboxConfig) {
    this.sandboxConfig = sandboxConfig;
    this.execPolicyRuntime = new LocalExecPolicyRuntime(sandboxConfig);
  }

  async execute(req: SandboxExecRequest): Promise<ToolResult> {
    // ADR-005: compute permission intersection
    const { granted, denied } = computePermissionIntersection(
      req.permissions,
      this.sandboxConfig.allowedPermissions,
    );

    if (denied.length > 0) {
      return createPermissionDeniedResult(req, this.sandboxConfig, denied);
    }

    // ADR-010: enforce exec policy for shell tool BEFORE spawning
    if (
      req.tool === "shell" && req.args.command && req.args.dry_run === false
    ) {
      const command = req.args.command as string;
      const policyResult = await this.execPolicyRuntime.enforce(command, req);
      if (policyResult) return policyResult;
    }

    return runLocalToolExecutor(req, this.sandboxConfig, granted);
  }

  async close(): Promise<void> {
    // No-op: local process backend has no persistent resources
  }
}
