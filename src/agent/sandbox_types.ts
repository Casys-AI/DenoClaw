/**
 * Agent sandbox and approval contracts (agent domain).
 *
 * Kept outside shared kernel because these types describe agent-internal
 * execution policy and sandbox backend orchestration concerns.
 */

import type { SandboxPermission, ToolResult } from "../shared/types.ts";

export type ApprovalReason =
  | "not-in-allowlist"
  | "shell-operator"
  | "inline-eval"
  | "always-ask";

interface ExecPolicyBase {
  ask: "off" | "on-miss" | "always";
  askFallback?: "deny" | "allowlist";
}

interface ExecPolicyDeny extends ExecPolicyBase {
  security: "deny";
}

interface ExecPolicyFull extends ExecPolicyBase {
  security: "full";
  /** Additional env prefixes to strip (on top of LD_*, DYLD_*) */
  envFilter?: string[];
}

interface ExecPolicyAllowlist extends ExecPolicyBase {
  security: "allowlist";
  allowedCommands?: string[];
  /** Keyword blocklist — matches anywhere in command string (intentionally aggressive) */
  deniedCommands?: string[];
  /** Additional env prefixes to strip (on top of LD_*, DYLD_*) */
  envFilter?: string[];
  /** Allow -c/-e flags on interpreters (default: false = blocked) */
  allowInlineEval?: boolean;
}

export type ExecPolicy = ExecPolicyDeny | ExecPolicyFull | ExecPolicyAllowlist;

export interface ApprovalRequest {
  requestId: string;
  command: string;
  binary: string;
  reason: ApprovalReason;
}

export interface ApprovalResponse {
  approved: boolean;
  allowAlways?: boolean;
}

export interface SandboxExecRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy: ExecPolicy;
  toolsConfig?: { restrictToWorkspace?: boolean; workspaceDir?: string; agentId?: string };
  onAskApproval?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
}

export interface SandboxBackend {
  readonly kind: "local" | "cloud";
  readonly supportsFullShell: boolean;
  execute(req: SandboxExecRequest): Promise<ToolResult>;
  close(): Promise<void>;
}
