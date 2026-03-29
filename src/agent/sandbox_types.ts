/**
 * Agent sandbox and approval contracts.
 *
 * These types are consumed across files, but their ownership is agent-side:
 * they describe how agent tooling execution is approved, filtered and run.
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
