import type {
  ApprovalReason,
  ExecPolicy,
  SandboxConfig,
  SandboxExecRequest,
  ToolResult,
} from "../../../shared/types.ts";
import { log } from "../../../shared/log.ts";
import { checkExecPolicy, type ExecPolicyCheck } from "../shell.ts";

export class LocalExecPolicyRuntime {
  private sandboxConfig: SandboxConfig;
  private sessionAllowlist = new Set<string>();

  constructor(sandboxConfig: SandboxConfig) {
    this.sandboxConfig = sandboxConfig;
  }

  async enforce(
    command: string,
    req: SandboxExecRequest,
  ): Promise<ToolResult | null> {
    const policy = this.mergeSessionAllowlist(req.execPolicy);
    const check = checkExecPolicy(command, policy);

    if (check.allowed) {
      return null;
    }

    if (this.shouldAsk(policy, check.reason)) {
      const approvalResult = await this.requestApproval(command, check, req);
      if (approvalResult) {
        return null;
      }
    }

    return this.execDenied(
      command,
      check.binary ?? command,
      check.reason ?? "denied",
    );
  }

  private shouldAsk(
    policy: ExecPolicy,
    reason?: ApprovalReason | "denied",
  ): boolean {
    return reason !== "denied" &&
      (policy.ask === "always" || policy.ask === "on-miss");
  }

  private async requestApproval(
    command: string,
    check: ExecPolicyCheck,
    req: SandboxExecRequest,
  ): Promise<boolean> {
    if (!req.onAskApproval) {
      return this.allowWithoutApprovalChannel(command, req.execPolicy);
    }

    let approvalTimer: number | undefined;

    try {
      const ms = (this.sandboxConfig.approvalTimeoutSec ?? 60) * 1000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        approvalTimer = setTimeout(
          () => reject(new Error("approval_timeout")),
          ms,
        );
      });

      const response = await Promise.race([
        req.onAskApproval({
          requestId: crypto.randomUUID(),
          command,
          binary: check.binary ?? command,
          reason: (check.reason ?? "not-in-allowlist") as ApprovalReason,
        }),
        timeoutPromise,
      ]);

      if (response.approved) {
        if (response.allowAlways && check.binary) {
          this.sessionAllowlist.add(check.binary);
        }
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "approval_timeout") {
        log.warn(`Approval timeout for '${check.binary}' — denying`);
      } else {
        log.error(`Approval callback error for '${check.binary}': ${message}`);
      }
    } finally {
      if (approvalTimer !== undefined) {
        clearTimeout(approvalTimer);
      }
    }

    return false;
  }

  private allowWithoutApprovalChannel(
    command: string,
    policy: ExecPolicy,
  ): boolean {
    if (policy.askFallback !== "allowlist") {
      return false;
    }

    const fallbackCheck = checkExecPolicy(command, {
      ...policy,
      ask: "off",
    });
    return fallbackCheck.allowed;
  }

  private mergeSessionAllowlist(policy: ExecPolicy): ExecPolicy {
    if (this.sessionAllowlist.size === 0 || policy.security !== "allowlist") {
      return policy;
    }

    return {
      ...policy,
      allowedCommands: [
        ...(policy.allowedCommands ?? []),
        ...this.sessionAllowlist,
      ],
    };
  }

  private execDenied(
    command: string,
    binary: string,
    reason: string,
  ): ToolResult {
    return {
      success: false,
      output: "",
      error: {
        code: "EXEC_DENIED",
        context: { command, binary, reason },
        recovery:
          `Add '${binary}' to execPolicy.allowedCommands or use ask: 'on-miss'`,
      },
    };
  }
}
