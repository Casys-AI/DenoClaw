import type {
  SandboxConfig,
  SandboxExecRequest,
  ToolResult,
} from "../../../shared/types.ts";
import { checkExecPolicy } from "../shell.ts";

/**
 * Shared backend-side exec policy guard.
 *
 * Every backend uses the same guard before execution so the policy does not
 * depend on a specific backend implementation.
 */
export class ExecPolicyGuard {
  constructor(_sandboxConfig: SandboxConfig) {}

  shouldEnforce(req: SandboxExecRequest): boolean {
    return req.tool === "shell" && !!req.args.command &&
      req.args.dry_run === false;
  }

  enforce(
    command: string,
    req: SandboxExecRequest,
  ): ToolResult | null {
    const check = checkExecPolicy(command, req.execPolicy, req.shell);

    if (check.allowed) {
      return null;
    }

    return this.execDenied(
      command,
      check.binary ?? command,
      check.reason ?? "denied",
      check.recovery,
    );
  }

  private execDenied(
    command: string,
    binary: string,
    reason: string,
    recovery?: string,
  ): ToolResult {
    return {
      success: false,
      output: "",
      error: {
        code: "EXEC_DENIED",
        context: { command, binary, reason },
        recovery: recovery ??
          `Update execPolicy to allow '${binary}' or relax execPolicy.security`,
      },
    };
  }
}
