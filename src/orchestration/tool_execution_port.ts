import type {
  ExecPolicy,
  SandboxPermission,
  ToolResult,
} from "../shared/types.ts";

export interface ExecPolicyCheckResult {
  allowed: boolean;
  reason?: string;
  binary?: string;
}

export type SandboxOwnershipScope = "agent";

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
  toolsConfig?: Record<string, unknown>;
  executionContext?: ToolExecutionContext;
}

export interface ToolExecutionPort {
  executeTool(request: ExecuteToolRequest): Promise<ToolResult>;
  resolveToolPermissions(
    tool: string,
    tunnelPermissions?: Readonly<Record<string, SandboxPermission[]>>,
  ): SandboxPermission[];
  checkExecPolicy(command: string, policy: ExecPolicy): ExecPolicyCheckResult;
  getToolPermissions(): Record<string, SandboxPermission[]>;
  close?(): Promise<void>;
}
