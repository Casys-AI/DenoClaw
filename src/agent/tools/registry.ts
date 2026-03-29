import type {
  SandboxPermission,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ExecPolicy,
  SandboxBackend,
} from "../sandbox_types.ts";
import type { ToolsConfig } from "../types.ts";
import { log } from "../../shared/log.ts";

/** Default exec policy — deny-first, allowlist with on-miss (AX #2 Safe Defaults). */
const DEFAULT_EXEC_POLICY: ExecPolicy = {
  security: "allowlist",
  allowedCommands: [],
  ask: "on-miss",
  askFallback: "deny",
};

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract permissions: SandboxPermission[];
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
  private onAskApproval?: (req: ApprovalRequest) => Promise<ApprovalResponse>;

  /** Set the sandbox backend (ADR-010). */
  setBackend(
    backend: SandboxBackend,
    execPolicy?: ExecPolicy,
    toolsConfig?: ToolsConfig,
    networkAllow?: string[],
  ): void {
    this.backend = backend;
    this.execPolicy = execPolicy ?? DEFAULT_EXEC_POLICY;
    this.toolsConfig = toolsConfig;
    this.networkAllow = networkAllow;
    log.debug(
      `SandboxBackend: kind=${backend.kind} supportsFullShell=${backend.supportsFullShell}`,
    );
  }

  /** Set the approval callback for exec policy ask flows. */
  setAskApproval(
    fn: (req: ApprovalRequest) => Promise<ApprovalResponse>,
  ): void {
    this.onAskApproval = fn;
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
      if (this.backend && tool.permissions.length > 0) {
        log.info(`Tool execution (sandbox ${this.backend.kind}): ${name}`);
        return await this.backend.execute({
          tool: name,
          args,
          permissions: tool.permissions,
          networkAllow: this.networkAllow,
          execPolicy: this.execPolicy,
          toolsConfig: this.toolsConfig,
          onAskApproval: this.onAskApproval,
        });
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
