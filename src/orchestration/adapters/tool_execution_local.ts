import type {
  ExecPolicy,
  SandboxPermission,
  ShellConfig,
  ToolResult,
} from "../../shared/types.ts";
import type {
  ExecPolicyCheckResult,
  ExecuteToolRequest,
  ToolExecutionPort,
} from "../tool_execution_port.ts";
import type { BuiltinToolName } from "../../agent/tools/types.ts";
import { BUILTIN_TOOL_PERMISSIONS } from "../../agent/tools/types.ts";
import { checkExecPolicy } from "../../agent/tools/shell.ts";
import { ToolRegistry } from "../../agent/tools/registry.ts";
import { ShellTool } from "../../agent/tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "../../agent/tools/file.ts";
import { WebFetchTool } from "../../agent/tools/web.ts";
import { log } from "../../shared/log.ts";

export interface LocalToolExecutionAdapterOptions {
  registry?: ToolRegistry;
  sandbox?: Pick<ToolExecutionPort, "executeTool" | "close"> | null;
  requireSandboxForPermissionedTools?: boolean;
}

function isBuiltinTool(tool: string): tool is BuiltinToolName {
  return tool in BUILTIN_TOOL_PERMISSIONS;
}

export class LocalToolExecutionAdapter implements ToolExecutionPort {
  private registry: ToolRegistry;
  private sandbox: Pick<ToolExecutionPort, "executeTool" | "close"> | null;
  private requireSandboxForPermissionedTools: boolean;

  constructor(options?: LocalToolExecutionAdapterOptions) {
    this.registry = options?.registry ?? new ToolRegistry();
    this.sandbox = options?.sandbox ?? null;
    this.requireSandboxForPermissionedTools =
      options?.requireSandboxForPermissionedTools ?? false;
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
      return this.sandbox.executeTool(request);
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
            "Set DENOCLAW_SANDBOX_API_TOKEN or connect a relay for local tool execution",
        },
      });
    }

    if (request.tool === "shell" && request.shell) {
      if (
        request.shell.mode === "system-shell" &&
        request.shell.warnOnLocalSystemShell !== false
      ) {
        log.warn(
          "ShellTool: local system-shell mode is enabled; command semantics are delegated to the host shell",
        );
      }
      return new ShellTool(false, request.shell).execute(request.args);
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

  checkExecPolicy(
    command: string,
    policy: ExecPolicy,
    shell?: ShellConfig,
  ): ExecPolicyCheckResult {
    return checkExecPolicy(command, policy, shell);
  }

  getToolPermissions(): Record<string, SandboxPermission[]> {
    return this.registry.getToolPermissions();
  }

  async close(): Promise<void> {
    await this.sandbox?.close?.();
  }
}
