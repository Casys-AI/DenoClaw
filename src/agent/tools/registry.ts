import type { ToolDefinition, ToolResult } from "../../types.ts";
import { log } from "../../utils/log.ts";

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract getDefinition(): ToolDefinition;
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  protected ok(output: string): ToolResult {
    return { success: true, output };
  }

  protected fail(code: string, context?: Record<string, unknown>, recovery?: string): ToolResult {
    return {
      success: false,
      output: "",
      error: { code, context, recovery },
    };
  }
}

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
    log.debug(`Outil enregistré : ${tool.name}`);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.getDefinition());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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
      log.info(`Exécution outil : ${name}`);
      return await tool.execute(args);
    } catch (e) {
      log.error(`Erreur outil ${name}`, e);
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

  get size(): number {
    return this.tools.size;
  }
}
