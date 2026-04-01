import type {
  ExecPolicy,
  SandboxPermission,
  ShellConfig,
  ToolExecutorConfig,
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
  getWorkspaceKv?: (() => Promise<Deno.Kv>) | null;
}

function isBuiltinTool(tool: string): tool is BuiltinToolName {
  return tool in BUILTIN_TOOL_PERMISSIONS;
}

function isWorkspaceTool(tool: string): tool is "read_file" | "write_file" {
  return tool === "read_file" || tool === "write_file";
}

export class LocalToolExecutionAdapter implements ToolExecutionPort {
  private registry: ToolRegistry;
  private sandbox: Pick<ToolExecutionPort, "executeTool" | "close"> | null;
  private requireSandboxForPermissionedTools: boolean;
  private getWorkspaceKv: (() => Promise<Deno.Kv>) | null;

  constructor(options?: LocalToolExecutionAdapterOptions) {
    this.registry = options?.registry ?? new ToolRegistry();
    this.sandbox = options?.sandbox ?? null;
    this.requireSandboxForPermissionedTools =
      options?.requireSandboxForPermissionedTools ?? false;
    this.getWorkspaceKv = options?.getWorkspaceKv ?? null;
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
    const workspaceExecution = this.executeWorkspaceTool(request);
    if (workspaceExecution) {
      return workspaceExecution;
    }

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

  private executeWorkspaceTool(
    request: ExecuteToolRequest,
  ): Promise<ToolResult> | null {
    if (!isWorkspaceTool(request.tool)) {
      return null;
    }

    const config = request.toolsConfig;
    if (!config?.workspaceBackend || !config.agentId) {
      return null;
    }

    if (config.workspaceBackend === "kv") {
      return this.executeWorkspaceKvTool(request.tool, request.args, config);
    }

    if (!config.workspaceDir) {
      return Promise.resolve({
        success: false,
        output: "",
        error: {
          code: "WORKSPACE_DIR_REQUIRED",
          context: { tool: request.tool, agentId: config.agentId },
          recovery:
            "Provide toolsConfig.workspaceDir when executing filesystem workspace tools",
        },
      });
    }

    const tool = request.tool === "read_file"
      ? new ReadFileTool({
        workspaceDir: config.workspaceDir,
        agentId: config.agentId,
        onDeploy: false,
      })
      : new WriteFileTool({
        workspaceDir: config.workspaceDir,
        agentId: config.agentId,
        onDeploy: false,
      });

    return tool.execute(request.args);
  }

  private async executeWorkspaceKvTool(
    tool: "read_file" | "write_file",
    args: Record<string, unknown>,
    config: ToolExecutorConfig,
  ): Promise<ToolResult> {
    if (!this.getWorkspaceKv) {
      return {
        success: false,
        output: "",
        error: {
          code: "WORKSPACE_KV_UNAVAILABLE",
          context: { tool, agentId: config.agentId },
          recovery:
            "Configure getWorkspaceKv() on the broker tool execution adapter before using workspaceBackend='kv'",
        },
      };
    }

    try {
      const kv = await this.getWorkspaceKv();
      const workspaceDir = config.workspaceDir ??
        `/workspace/${config.agentId}`;
      const workspaceContext = {
        workspaceDir,
        agentId: config.agentId!,
        kv,
        onDeploy: true,
      };
      const workspaceTool = tool === "read_file"
        ? new ReadFileTool(workspaceContext)
        : new WriteFileTool(workspaceContext);
      return await workspaceTool.execute(args);
    } catch (error) {
      return {
        success: false,
        output: "",
        error: {
          code: "WORKSPACE_KV_UNAVAILABLE",
          context: {
            tool,
            agentId: config.agentId,
            message: error instanceof Error ? error.message : String(error),
          },
          recovery:
            "Check that the broker can open the shared workspace KV before executing workspace tools",
        },
      };
    }
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
