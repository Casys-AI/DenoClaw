/**
 * Agent sandbox contracts.
 *
 * These types are consumed across files, but their ownership is agent-side:
 * they describe how agent tooling execution is filtered and run.
 */

import type { SandboxPermission, ToolResult } from "../shared/types.ts";

export type CommandMode = "direct" | "system-shell";

export interface ShellConfig {
  enabled?: boolean;
  mode?: CommandMode;
  warnOnLocalSystemShell?: boolean;
}

interface ExecPolicyBase {
  /**
   * Legacy compatibility knob from the old command-approval flow.
   * The current runtime is policy-first and does not rely on interactive
   * per-command approvals.
   */
  ask?: "off" | "on-miss" | "always";
  /**
   * Legacy compatibility fallback paired with `ask`.
   * Kept for config compatibility only.
   */
  askFallback?: "deny" | "allowlist";
}

interface ExecPolicyDeny extends ExecPolicyBase {
  security: "deny";
}

interface ExecPolicyFull extends ExecPolicyBase {
  security: "full";
  envFilter?: string[];
}

interface ExecPolicyAllowlist extends ExecPolicyBase {
  security: "allowlist";
  allowedCommands?: string[];
  deniedCommands?: string[];
  envFilter?: string[];
  allowInlineEval?: boolean;
}

export type ExecPolicy = ExecPolicyDeny | ExecPolicyFull | ExecPolicyAllowlist;

export interface SandboxExecRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy: ExecPolicy;
  shell?: ShellConfig;
  toolsConfig?: {
    restrictToWorkspace?: boolean;
    workspaceDir?: string;
    agentId?: string;
    shell?: ShellConfig;
  };
}

export interface SandboxBackend {
  readonly kind: "local" | "cloud";
  execute(req: SandboxExecRequest): Promise<ToolResult>;
  close(): Promise<void>;
}
