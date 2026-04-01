import type { SandboxPermission, ToolDefinition, ToolResult } from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";

export class CreateCronTool extends BaseTool {
  name = "create_cron";
  description = "Create a scheduled task that runs on a cron schedule";
  permissions: SandboxPermission[] = [];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short name for the cron job (e.g. 'email-check')" },
            schedule: { type: "string", description: "Cron expression (e.g. '0 8 * * *' for daily at 8am, '*/30 * * * *' for every 30 minutes)" },
            prompt: { type: "string", description: "The instruction to execute each time the cron fires" },
          },
          required: ["name", "schedule", "prompt"],
        },
      },
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return this.ok("create_cron is broker-backed — should not be called locally");
  }
}

export class ListCronsTool extends BaseTool {
  name = "list_crons";
  description = "List all scheduled cron jobs for this agent";
  permissions: SandboxPermission[] = [];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {} },
      },
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return this.ok("list_crons is broker-backed — should not be called locally");
  }
}

export class DeleteCronTool extends BaseTool {
  name = "delete_cron";
  description = "Delete a scheduled cron job";
  permissions: SandboxPermission[] = [];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            cronJobId: { type: "string", description: "The ID of the cron job to delete" },
          },
          required: ["cronJobId"],
        },
      },
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return this.ok("delete_cron is broker-backed — should not be called locally");
  }
}
