import type {
  ExecPolicy,
  SandboxPermission,
  ShellConfig,
  ToolResult,
} from "../shared/types.ts";

export interface ExecPolicyCheckResult {
  allowed: boolean;
  reason?: string;
  binary?: string;
  recovery?: string;
}

export type SandboxOwnershipScope = "agent" | "context";

export interface ToolExecutionContext {
  agentId?: string;
  taskId?: string;
  contextId?: string;
  ownershipScope?: SandboxOwnershipScope;
}

export interface ExecuteToolRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions?: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy?: ExecPolicy;
  shell?: ShellConfig;
  toolsConfig?: Record<string, unknown>;
  executionContext?: ToolExecutionContext;
}

export interface ToolExecutionPort {
  executeTool(request: ExecuteToolRequest): Promise<ToolResult>;
  resolveToolPermissions(
    tool: string,
    tunnelPermissions?: Readonly<Record<string, SandboxPermission[]>>,
  ): SandboxPermission[];
  checkExecPolicy(
    command: string,
    policy: ExecPolicy,
    shell?: ShellConfig,
  ): ExecPolicyCheckResult;
  getToolPermissions(): Record<string, SandboxPermission[]>;
  close?(): Promise<void>;
}
