/**
 * LocalProcessBackend — subprocess sandbox for local/dev mode (ADR-010).
 *
 * Spawns tool_executor.ts in a Deno subprocess with --allow-* flags
 * from ADR-005 permission intersection. Exec policy is enforced HERE,
 * before the subprocess is spawned.
 */

import type {
  ExecPolicy,
  SandboxBackend,
  SandboxConfig,
  SandboxExecRequest,
  SandboxPermission,
  ToolResult,
} from "../../../shared/mod.ts";
import { checkExecPolicy, filterEnv } from "../shell.ts";
import { log } from "../../../shared/log.ts";

const EXECUTOR_URL = new URL("../tool_executor.ts", import.meta.url).href;
const DENO_EXECUTABLE = Deno.execPath();
const DEFAULT_TIMEOUT_SEC = 30;

/** Map SandboxPermission → Deno CLI flag */
function permissionToFlag(
  perm: SandboxPermission,
  networkAllow?: string[],
): string {
  switch (perm) {
    case "read":
      return "--allow-read";
    case "write":
      return "--allow-write";
    case "run":
      return "--allow-run";
    case "net": {
      return networkAllow?.length
        ? `--allow-net=${networkAllow.join(",")}`
        : "--allow-net";
    }
    case "env":
      return "--allow-env";
    case "ffi":
      return "--allow-ffi";
  }
}

/** Compute intersection: only permissions the tool needs AND the agent allows. */
function computeIntersection(
  toolPerms: SandboxPermission[],
  agentPerms: SandboxPermission[],
): { granted: SandboxPermission[]; denied: SandboxPermission[] } {
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

export class LocalProcessBackend implements SandboxBackend {
  readonly kind = "local" as const;
  readonly supportsFullShell = false;

  private sandboxConfig: SandboxConfig;
  private sessionAllowlist = new Set<string>();

  constructor(sandboxConfig: SandboxConfig) {
    this.sandboxConfig = sandboxConfig;
  }

  async execute(req: SandboxExecRequest): Promise<ToolResult> {
    // ADR-005: compute permission intersection
    const { granted, denied } = computeIntersection(
      req.permissions,
      this.sandboxConfig.allowedPermissions,
    );

    if (denied.length > 0) {
      return {
        success: false,
        output: "",
        error: {
          code: "SANDBOX_PERMISSION_DENIED",
          context: {
            tool: req.tool,
            required: req.permissions,
            agentAllowed: this.sandboxConfig.allowedPermissions,
            denied,
          },
          recovery: `Add ${
            denied.map((d) => `'${d}'`).join(", ")
          } to agent sandbox.allowedPermissions`,
        },
      };
    }

    // ADR-010: enforce exec policy for shell tool BEFORE spawning
    if (
      req.tool === "shell" && req.args.command && req.args.dry_run === false
    ) {
      const command = req.args.command as string;
      const policyResult = await this.enforceExecPolicy(command, req);
      if (policyResult) return policyResult;
    }

    // Build Deno permission flags
    const flags = [
      ...granted.map((perm) => permissionToFlag(perm, req.networkAllow)),
      "--allow-env", // filterEnv() needs Deno.env.toObject() to strip dangerous prefixes
    ];

    // Build executor input
    const input = JSON.stringify({
      tool: req.tool,
      args: req.args,
      config: req.toolsConfig,
    });

    const timeoutSec = req.timeoutSec ?? this.sandboxConfig.maxDurationSec ??
      DEFAULT_TIMEOUT_SEC;

    log.debug(
      `LocalProcess: ${req.tool} flags=[${
        flags.join(", ")
      }] timeout=${timeoutSec}s`,
    );

    try {
      // Wire envFilter from exec policy (Design 1)
      const envExtra =
        (req.execPolicy.security !== "deny" && "envFilter" in req.execPolicy)
          ? (req.execPolicy as { envFilter?: string[] }).envFilter
          : undefined;

      const cmd = new Deno.Command(DENO_EXECUTABLE, {
        args: ["run", ...flags, EXECUTOR_URL, input],
        stdout: "piped",
        stderr: "piped",
        env: filterEnv(envExtra),
      });

      const process = cmd.spawn();

      const timer = setTimeout(() => {
        try {
          process.kill("SIGKILL");
        } catch { /* already dead */ }
      }, timeoutSec * 1000);

      const { stdout, stderr, success, code } = await process.output();
      clearTimeout(timer);

      const out = new TextDecoder().decode(stdout).trim();
      const err = new TextDecoder().decode(stderr).trim();

      if (err) log.debug(`LocalProcess stderr: ${err.slice(0, 500)}`);

      if (!success) {
        return {
          success: false,
          output: "",
          error: {
            code: "SANDBOX_EXIT_ERROR",
            context: {
              tool: req.tool,
              exitCode: code,
              stderr: err.slice(0, 500),
            },
            recovery: "Check tool permissions and input arguments",
          },
        };
      }

      try {
        return JSON.parse(out) as ToolResult;
      } catch {
        return {
          success: false,
          output: "",
          error: {
            code: "SANDBOX_PARSE_ERROR",
            context: { tool: req.tool, stdout: out.slice(0, 500) },
            recovery: "Tool executor returned invalid JSON",
          },
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        output: "",
        error: {
          code: "SANDBOX_SPAWN_ERROR",
          context: { tool: req.tool, message: msg },
          recovery: "Check that 'deno' is in PATH",
        },
      };
    }
  }

  async close(): Promise<void> {
    // No-op: local process backend has no persistent resources
  }

  // ── Exec policy enforcement (ADR-010) ──

  private async enforceExecPolicy(
    command: string,
    req: SandboxExecRequest,
  ): Promise<ToolResult | null> {
    const policy = this.mergeSessionAllowlist(req.execPolicy);
    const check = checkExecPolicy(command, policy);

    if (check.allowed) return null; // proceed to spawn

    // Ask flow
    if (
      check.reason !== "denied" &&
      (policy.ask === "always" || policy.ask === "on-miss")
    ) {
      if (!req.onAskApproval) {
        // No approval channel — apply fallback
        if (policy.askFallback === "allowlist") {
          const fallbackCheck = checkExecPolicy(command, {
            ...policy,
            ask: "off",
          });
          if (fallbackCheck.allowed) return null;
        }
        return this.execDenied(
          command,
          check.binary ?? command,
          check.reason ?? "not-in-allowlist",
        );
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
            reason: check.reason ?? "not-in-allowlist",
          }),
          timeoutPromise,
        ]);

        if (response.approved) {
          if (response.allowAlways && check.binary) {
            this.sessionAllowlist.add(check.binary);
          }
          return null; // proceed to spawn
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "approval_timeout") {
          log.warn(`Approval timeout for '${check.binary}' — denying`);
        } else {
          log.error(`Approval callback error for '${check.binary}': ${msg}`);
        }
      } finally {
        if (approvalTimer !== undefined) clearTimeout(approvalTimer);
      }
    }

    return this.execDenied(
      command,
      check.binary ?? command,
      check.reason ?? "denied",
    );
  }

  private mergeSessionAllowlist(policy: ExecPolicy): ExecPolicy {
    if (this.sessionAllowlist.size === 0) return policy;
    if (policy.security !== "allowlist") return policy;
    const merged = [
      ...(policy.allowedCommands ?? []),
      ...this.sessionAllowlist,
    ];
    return { ...policy, allowedCommands: merged };
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
