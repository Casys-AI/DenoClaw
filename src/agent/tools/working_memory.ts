import type { SandboxPermission, ToolDefinition, ToolResult } from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";

export interface WorkingMemoryPort {
  getWorkingMemory(): Promise<string>;
  updateWorkingMemory(content: string): Promise<void>;
}

export class WorkingMemoryTool extends BaseTool {
  name = "working_memory";
  description =
    "Read or update your persistent working memory. Actions: 'read' (get current memory), 'update' (replace with new content). Working memory persists across conversations.";
  permissions: SandboxPermission[] = [];

  constructor(private port: WorkingMemoryPort) {
    super();
  }

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["read", "update"],
              description:
                "Action: 'read' returns current working memory, 'update' replaces it",
            },
            content: {
              type: "string",
              description:
                "New working memory content (required for 'update' action). Use markdown format.",
            },
          },
          required: ["action"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    if (action === "read") {
      const content = await this.port.getWorkingMemory();
      return this.ok(content || "(empty)");
    }
    if (action === "update") {
      const content = args.content as string;
      if (!content) {
        return this.fail("MISSING_CONTENT", { action }, "Provide 'content' for update");
      }
      await this.port.updateWorkingMemory(content);
      return this.ok(JSON.stringify({ ok: true }));
    }
    return this.fail("UNKNOWN_ACTION", { action }, "Use 'read' or 'update'");
  }
}
