import type {
  SandboxPermission,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";

export interface CronToolPort {
  create(
    args: { name: string; schedule: string; prompt: string },
  ): Promise<ToolResult>;
  list(): Promise<ToolResult>;
  delete(cronJobId: string): Promise<ToolResult>;
  enable(cronJobId: string): Promise<ToolResult>;
  disable(cronJobId: string): Promise<ToolResult>;
}

abstract class CronToolBase extends BaseTool {
  permissions: SandboxPermission[] = ["schedule"];
  override usesSandboxBackend = false;

  constructor(protected readonly port?: CronToolPort) {
    super();
  }

  protected unavailable(): ToolResult {
    return this.fail(
      "CRON_UNAVAILABLE",
      { tool: this.name },
      "Run this agent behind a broker or gateway with cron support enabled",
    );
  }
}

export class CreateCronTool extends CronToolBase {
  name = "create_cron";
  description = "Create a scheduled task that runs on a cron schedule";

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short name for the cron job (e.g. 'email-check')",
            },
            schedule: {
              type: "string",
              description:
                "Cron expression (e.g. '0 8 * * *' for daily at 8am, '*/30 * * * *' for every 30 minutes)",
            },
            prompt: {
              type: "string",
              description:
                "The instruction to execute each time the cron fires",
            },
            dry_run: {
              type: "boolean",
              description:
                "Preview the cron without creating it (default: true)",
            },
          },
          required: ["name", "schedule", "prompt"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.port) {
      return this.unavailable();
    }

    const name = typeof args.name === "string" ? args.name.trim() : "";
    const schedule = typeof args.schedule === "string"
      ? args.schedule.trim()
      : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!name || !schedule || !prompt) {
      return this.fail(
        "INVALID_CRON_ARGS",
        { name, schedule, prompt },
        "Provide non-empty name, schedule (cron expression), and prompt",
      );
    }

    if (args.dry_run !== false) {
      return this.ok(JSON.stringify({
        dry_run: true,
        would_create: { name, schedule, prompt },
      }));
    }

    return await this.port.create({ name, schedule, prompt });
  }
}

export class ListCronsTool extends CronToolBase {
  name = "list_crons";
  description = "List all scheduled cron jobs for this agent";

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
    if (!this.port) {
      return this.unavailable();
    }
    return await this.port.list();
  }
}

export class DeleteCronTool extends CronToolBase {
  name = "delete_cron";
  description = "Delete a scheduled cron job";

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            cronJobId: {
              type: "string",
              description: "The ID of the cron job to delete",
            },
            dry_run: {
              type: "boolean",
              description:
                "Preview the deletion without executing it (default: true)",
            },
          },
          required: ["cronJobId"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.port) {
      return this.unavailable();
    }

    const cronJobId = typeof args.cronJobId === "string"
      ? args.cronJobId.trim()
      : "";
    if (!cronJobId) {
      return this.fail(
        "INVALID_CRON_ARGS",
        { cronJobId },
        "Provide a non-empty cronJobId",
      );
    }

    if (args.dry_run !== false) {
      return this.ok(JSON.stringify({ dry_run: true, would_delete: cronJobId }));
    }

    return await this.port.delete(cronJobId);
  }
}

abstract class ToggleCronToolBase extends CronToolBase {
  protected getCronJobId(args: Record<string, unknown>): string | null {
    const cronJobId = typeof args.cronJobId === "string"
      ? args.cronJobId.trim()
      : "";
    if (!cronJobId) {
      return null;
    }
    return cronJobId;
  }

  protected getCronJobIdDefinition(description: string): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            cronJobId: { type: "string", description },
            dry_run: {
              type: "boolean",
              description: "Preview the operation without executing it (default: true)",
            },
          },
          required: ["cronJobId"],
        },
      },
    };
  }
}

export class EnableCronTool extends ToggleCronToolBase {
  name = "enable_cron";
  description = "Enable a scheduled cron job";

  getDefinition(): ToolDefinition {
    return this.getCronJobIdDefinition("The ID of the cron job to enable");
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.port) {
      return this.unavailable();
    }

    const cronJobId = this.getCronJobId(args);
    if (!cronJobId) {
      return this.fail(
        "INVALID_CRON_ARGS",
        { cronJobId: args.cronJobId },
        "Provide a non-empty cronJobId",
      );
    }

    if (args.dry_run !== false) {
      return this.ok(JSON.stringify({ dry_run: true, would_enable: cronJobId }));
    }

    return await this.port.enable(cronJobId);
  }
}

export class DisableCronTool extends ToggleCronToolBase {
  name = "disable_cron";
  description = "Disable a scheduled cron job without deleting it";

  getDefinition(): ToolDefinition {
    return this.getCronJobIdDefinition("The ID of the cron job to disable");
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.port) {
      return this.unavailable();
    }

    const cronJobId = this.getCronJobId(args);
    if (!cronJobId) {
      return this.fail(
        "INVALID_CRON_ARGS",
        { cronJobId: args.cronJobId },
        "Provide a non-empty cronJobId",
      );
    }

    if (args.dry_run !== false) {
      return this.ok(JSON.stringify({ dry_run: true, would_disable: cronJobId }));
    }

    return await this.port.disable(cronJobId);
  }
}
