import type {
  ExecPolicy,
  SandboxPermission,
  ToolResult,
} from "../../shared/types.ts";
import type {
  ExecuteToolRequest,
  ExecPolicyCheckResult,
  ToolExecutionPort,
} from "../tool_execution_port.ts";
import type { BuiltinToolName } from "../../agent/tools/types.ts";
import { BUILTIN_TOOL_PERMISSIONS } from "../../agent/tools/types.ts";
import { checkExecPolicy } from "../../agent/tools/shell.ts";
import { ToolRegistry } from "../../agent/tools/registry.ts";
import { ShellTool } from "../../agent/tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "../../agent/tools/file.ts";
import { WebFetchTool } from "../../agent/tools/web.ts";
import { DenoSandboxBackend } from "../../agent/tools/backends/cloud.ts";

export interface LocalToolExecutionAdapterOptions {
  registry?: ToolRegistry;
  sandbox?: DenoSandboxBackend | null;
  requireSandboxForPermissionedTools?: boolean;
}

function isBuiltinTool(tool: string): tool is BuiltinToolName {
  return tool in BUILTIN_TOOL_PERMISSIONS;
}

export class LocalToolExecutionAdapter implements ToolExecutionPort {
  private registry: ToolRegistry;
  private sandbox: DenoSandboxBackend | null;
  private requireSandboxForPermissionedTools: boolean;

  constructor(options?: LocalToolExecutionAdapterOptions) {
    this.registry = options?.registry ?? new ToolRegistry();
    this.sandbox = options?.sandbox ?? null;
    this.requireSandboxForPermissionedTools = options?.requireSandboxForPermissionedTools ?? false;
  }

  static forRelay(tools: string[]): LocalToolExecutionAdapter {
    const registry = new ToolRegistry();

    if (tools.includes("shell")) {
      registry.register(new ShellTool());
    }
    if (tools.includes("read_file") || tools.includes("fs_read")) {
      registry.register(new ReadFileTool());
    }
    if (tools.includes("write_file") || tools.includes("fs_write")) {
      registry.register(new WriteFileTool());
    }
    if (tools.includes("web_fetch")) {
      registry.register(new WebFetchTool());
    }

    return new LocalToolExecutionAdapter({ registry });
  }

  executeTool(request: ExecuteToolRequest): Promise<ToolResult> {
    if (this.sandbox && request.permissions && request.execPolicy) {
      return this.sandbox.execute({
        tool: request.tool,
        args: request.args,
        permissions: request.permissions,
        networkAllow: request.networkAllow,
        timeoutSec: request.timeoutSec,
        execPolicy: request.execPolicy,
        toolsConfig: request.toolsConfig,
      });
    }
    if (
      this.requireSandboxForPermissionedTools &&
      request.permissions &&
      request.permissions.length > 0
    ) {
      return Promise.resolve({
        success: false,
        output: "",
        error: {
          code: "NO_SANDBOX_BACKEND",
          context: { tool: request.tool },
          recovery:
            "Set DENO_SANDBOX_API_TOKEN or connect a relay for local tool execution",
        },
      });
    }

    return this.registry.execute(request.tool, request.args);
  }

  resolveToolPermissions(
    tool: string,
    tunnelPermissions?: Readonly<Record<string, SandboxPermission[]>>,
  ): SandboxPermission[] {
    if (isBuiltinTool(tool)) {
      return [...BUILTIN_TOOL_PERMISSIONS[tool]];
    }

    if (tunnelPermissions?.[tool]) {
      return [...tunnelPermissions[tool]];
    }

    return [];
  }

  checkExecPolicy(command: string, policy: ExecPolicy): ExecPolicyCheckResult {
    return checkExecPolicy(command, policy);
  }

  getToolPermissions(): Record<string, SandboxPermission[]> {
    return this.registry.getToolPermissions();
  }
}
