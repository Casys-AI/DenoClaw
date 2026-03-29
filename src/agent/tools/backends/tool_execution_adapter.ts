import type { ExecPolicy, SandboxPermission, ToolResult } from "../../../shared/types.ts";
import type { ToolExecutionPort } from "../../../orchestration/tool_execution_port.ts";
import type { TunnelCapabilities } from "../../../orchestration/types.ts";
import type { BuiltinToolName } from "../types.ts";
import { BUILTIN_TOOL_PERMISSIONS } from "../types.ts";
import { checkExecPolicy } from "../shell.ts";
import { ToolRegistry } from "../registry.ts";
import { ShellTool } from "../shell.ts";
import { ReadFileTool, WriteFileTool } from "../file.ts";
import { WebFetchTool } from "../web.ts";

function isBuiltinTool(tool: string): tool is BuiltinToolName {
  return tool in BUILTIN_TOOL_PERMISSIONS;
}

export class ToolExecutionAdapter implements ToolExecutionPort {
  private readonly registry = new ToolRegistry();

  constructor(tools: readonly string[]) {
    if (tools.includes("shell")) {
      this.registry.register(new ShellTool());
    }
    if (tools.includes("read_file") || tools.includes("fs_read")) {
      this.registry.register(new ReadFileTool());
    }
    if (tools.includes("write_file") || tools.includes("fs_write")) {
      this.registry.register(new WriteFileTool());
    }
    if (tools.includes("web_fetch")) {
      this.registry.register(new WebFetchTool());
    }
  }

  executeTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return this.registry.execute(tool, args);
  }

  getAdvertisedToolPermissions(
    tools: readonly string[],
  ): Record<string, SandboxPermission[]> {
    const available = this.registry.getToolPermissions();
    const result: Record<string, SandboxPermission[]> = {};

    for (const tool of tools) {
      if (available[tool]) {
        result[tool] = [...available[tool]];
      }
    }

    return result;
  }

  resolveRequiredPermissions(
    tool: string,
    tunnelCapabilities: Iterable<TunnelCapabilities>,
  ): SandboxPermission[] {
    if (isBuiltinTool(tool)) {
      return [...BUILTIN_TOOL_PERMISSIONS[tool]];
    }

    for (const tunnel of tunnelCapabilities) {
      const permissions = tunnel.toolPermissions?.[tool];
      if (permissions) {
        return [...permissions];
      }
    }

    return [];
  }

  evaluateExecPolicy(command: string, policy: ExecPolicy) {
    return checkExecPolicy(command, policy);
  }
}

export function createToolExecutionAdapter(
  tools: readonly string[],
): ToolExecutionPort {
  return new ToolExecutionAdapter(tools);
}
