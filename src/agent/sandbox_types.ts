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

interface ExecPolicyDeny {
  security: "deny";
}

interface ExecPolicyFull {
  security: "full";
  envFilter?: string[];
}

interface ExecPolicyAllowlist {
  security: "allowlist";
  allowedCommands?: string[];
  deniedCommands?: string[];
  envFilter?: string[];
  allowInlineEval?: boolean;
}

export type ExecPolicy = ExecPolicyDeny | ExecPolicyFull | ExecPolicyAllowlist;

export type WorkspaceBackend = "filesystem" | "kv";

export interface ToolExecutorConfig {
  restrictToWorkspace?: boolean;
  workspaceDir?: string;
  agentId?: string;
  workspaceBackend?: WorkspaceBackend;
  shell?: ShellConfig;
}

export interface SandboxExecRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy: ExecPolicy;
  shell?: ShellConfig;
  toolsConfig?: ToolExecutorConfig;
}

export interface SandboxBackend {
  readonly kind: "local" | "cloud";
  execute(req: SandboxExecRequest): Promise<ToolResult>;
  close(): Promise<void>;
}
