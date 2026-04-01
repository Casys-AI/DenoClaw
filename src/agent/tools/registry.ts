import type {
  ExecPolicy,
  SandboxExecRequest,
  SandboxBackend,
  SandboxConfig,
  SandboxPermission,
  ShellConfig,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import type { ToolsConfig } from "../types.ts";
import { log } from "../../shared/log.ts";
import type { AgentRuntimeCapabilities } from "../../shared/runtime_capabilities.ts";
import { normalizeAgentFacingToolResult } from "../../shared/tool_result_normalization.ts";
import { suggestPrivilegeElevationGrantResources } from "../../shared/privilege_elevation.ts";
import {
  computePermissionIntersection,
  createPermissionDeniedResult,
} from "./backends/sandbox_permissions.ts";

/** Default exec policy — deny-first, allowlist, no interactive approval by default. */
const DEFAULT_EXEC_POLICY: ExecPolicy = {
  security: "allowlist",
  allowedCommands: [],
};

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract permissions: SandboxPermission[];
  usesSandboxBackend = true;
  abstract getDefinition(): ToolDefinition;
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  protected ok(output: string): ToolResult {
    return { success: true, output };
  }

  protected fail(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ): ToolResult {
    return {
      success: false,
      output: "",
      error: { code, context, recovery },
    };
  }
}

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();
  private backend?: SandboxBackend;
  private execPolicy: ExecPolicy = DEFAULT_EXEC_POLICY;
  private toolsConfig?: ToolsConfig;
  private networkAllow?: string[];
  private shellConfig?: ShellConfig;
  private sandboxConfig?: SandboxConfig;
  private runtimeCapabilities?: AgentRuntimeCapabilities;

  /** Set the sandbox backend (ADR-010). */
  setBackend(
    backend: SandboxBackend,
    execPolicy?: ExecPolicy,
    toolsConfig?: ToolsConfig,
    networkAllow?: string[],
    shellConfig?: ShellConfig,
    sandboxConfig?: SandboxConfig,
    runtimeCapabilities?: AgentRuntimeCapabilities,
  ): void {
    this.backend = backend;
    this.execPolicy = execPolicy ?? DEFAULT_EXEC_POLICY;
    this.toolsConfig = toolsConfig;
    this.networkAllow = networkAllow;
    this.shellConfig = shellConfig;
    this.sandboxConfig = sandboxConfig;
    this.runtimeCapabilities = runtimeCapabilities;
    log.debug(`SandboxBackend: kind=${backend.kind}`);
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
    log.debug(`Tool registered: ${tool.name}`);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.getDefinition());
  }

  getToolPermissions(): Record<string, SandboxPermission[]> {
    const perms: Record<string, SandboxPermission[]> = {};
    for (const [name, tool] of this.tools) {
      perms[name] = [...tool.permissions];
    }
    return perms;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: "",
        error: {
          code: "TOOL_NOT_FOUND",
          context: { tool: name, available: [...this.tools.keys()] },
          recovery: `Use one of: ${[...this.tools.keys()].join(", ")}`,
        },
      };
    }

    try {
      // ADR-010: tools with permissions execute via SandboxBackend
      if (this.backend && tool.permissions.length > 0 && tool.usesSandboxBackend) {
        log.info(`Tool execution (sandbox ${this.backend.kind}): ${name}`);
        const result = await this.backend.execute({
          tool: name,
          args,
          permissions: tool.permissions,
          networkAllow: this.networkAllow,
          execPolicy: this.execPolicy,
          shell: this.shellConfig,
          toolsConfig: this.toolsConfig,
        });
        const command = name === "shell" && typeof args.command === "string"
          ? args.command
          : undefined;
        const binary = command ? command.trim().split(/\s+/)[0] : undefined;
        return normalizeAgentFacingToolResult(result, {
          tool: name,
          command,
          binary,
          requiredPermissions: tool.permissions,
          agentAllowed: this.sandboxConfig?.allowedPermissions ?? [],
          suggestedGrants: suggestPrivilegeElevationGrantResources(
            name,
            args,
            tool.permissions,
          ),
          capabilities: this.runtimeCapabilities,
          elevationAvailable: false,
          elevationReason:
            this.runtimeCapabilities?.sandbox.privilegeElevation.supported
              ? "no_channel"
              : "broker_unsupported",
        });
      }

      const localPermissionDenied = this.checkDirectToolPermissions(tool, args);
      if (localPermissionDenied) {
        return localPermissionDenied;
      }

      log.info(`Tool execution: ${name}`);
      return await tool.execute(args);
    } catch (e) {
      log.error(`Tool error ${name}`, e);
      return {
        success: false,
        output: "",
        error: {
          code: "TOOL_EXEC_FAILED",
          context: { tool: name, message: (e as Error).message },
          recovery: "Check tool arguments and retry",
        },
      };
    }
  }

  private checkDirectToolPermissions(
    tool: BaseTool,
    args: Record<string, unknown>,
  ): ToolResult | null {
    if (tool.permissions.length === 0 || !this.sandboxConfig) {
      return null;
    }

    const { denied } = computePermissionIntersection(
      tool.permissions,
      this.sandboxConfig.allowedPermissions,
    );
    if (denied.length === 0) {
      return null;
    }

    const deniedResult = createPermissionDeniedResult(
      {
        tool: tool.name,
        args,
        permissions: tool.permissions,
        execPolicy: this.execPolicy,
        ...(this.networkAllow ? { networkAllow: this.networkAllow } : {}),
        ...(this.toolsConfig ? { toolsConfig: this.toolsConfig } : {}),
        ...(this.shellConfig ? { shell: this.shellConfig } : {}),
      } satisfies SandboxExecRequest,
      this.sandboxConfig,
      denied,
    );

    const command = tool.name === "shell" && typeof args.command === "string"
      ? args.command
      : undefined;
    const binary = command ? command.trim().split(/\s+/)[0] : undefined;

    return normalizeAgentFacingToolResult(deniedResult, {
      tool: tool.name,
      command,
      binary,
      requiredPermissions: tool.permissions,
      agentAllowed: this.sandboxConfig.allowedPermissions,
      denied,
      suggestedGrants: suggestPrivilegeElevationGrantResources(
        tool.name,
        args,
        denied,
      ),
      capabilities: this.runtimeCapabilities,
      elevationAvailable: false,
      elevationReason:
        this.runtimeCapabilities?.sandbox.privilegeElevation.supported
          ? "no_channel"
          : "broker_unsupported",
    });
  }

  /** Close the sandbox backend and release resources. Never throws — logs errors. */
  async close(): Promise<void> {
    if (this.backend) {
      try {
        await this.backend.close();
      } catch (e) {
        log.error(
          `Backend close failed (${this.backend.kind}): ${
            (e as Error).message
          }`,
        );
      }
    }
  }

  get size(): number {
    return this.tools.size;
  }
}
