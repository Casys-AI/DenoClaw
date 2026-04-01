import type { ToolResult } from "../../shared/types.ts";
import type { BrokerCronManager } from "./cron_manager.ts";

export type CronToolName =
  | "create_cron"
  | "list_crons"
  | "delete_cron"
  | "enable_cron"
  | "disable_cron";

export async function executeCronToolRequest(
  cronManager: BrokerCronManager | null | undefined,
  agentId: string,
  tool: CronToolName,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!cronManager) {
    return {
      success: false,
      output: "",
      error: {
        code: "CRON_UNAVAILABLE",
        context: {},
        recovery: "Cron manager not configured",
      },
    };
  }

  switch (tool) {
    case "create_cron": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const schedule = typeof args.schedule === "string"
        ? args.schedule.trim()
        : "";
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!name || !schedule || !prompt) {
        return {
          success: false,
          output: "",
          error: {
            code: "INVALID_CRON_ARGS",
            context: { name, schedule, prompt },
            recovery:
              "Provide non-empty name, schedule (cron expression), and prompt",
          },
        };
      }

      const job = await cronManager.create({ agentId, name, schedule, prompt });
      return {
        success: true,
        output: JSON.stringify({
          created: true,
          id: job.id,
          name: job.name,
          schedule: job.schedule,
        }),
      };
    }
    case "list_crons": {
      const jobs = await cronManager.listByAgent(agentId);
      return {
        success: true,
        output: JSON.stringify({
          jobs: jobs.map((job) => ({
            id: job.id,
            name: job.name,
            schedule: job.schedule,
            prompt: job.prompt,
            enabled: job.enabled,
            lastRun: job.lastRun,
          })),
        }),
      };
    }
    case "delete_cron": {
      const cronJobId = typeof args.cronJobId === "string"
        ? args.cronJobId.trim()
        : "";
      if (!cronJobId) {
        return {
          success: false,
          output: "",
          error: {
            code: "INVALID_CRON_ARGS",
            context: { cronJobId },
            recovery: "Provide a non-empty cronJobId",
          },
        };
      }

      const deleted = await cronManager.delete(agentId, cronJobId);
      return { success: true, output: JSON.stringify({ deleted }) };
    }
    case "enable_cron":
    case "disable_cron": {
      const cronJobId = typeof args.cronJobId === "string"
        ? args.cronJobId.trim()
        : "";
      if (!cronJobId) {
        return {
          success: false,
          output: "",
          error: {
            code: "INVALID_CRON_ARGS",
            context: { cronJobId },
            recovery: "Provide a non-empty cronJobId",
          },
        };
      }

      const job = tool === "enable_cron"
        ? await cronManager.enable(agentId, cronJobId)
        : await cronManager.disable(agentId, cronJobId);
      return {
        success: true,
        output: JSON.stringify({
          updated: job !== null,
          cronJobId,
          enabled: job?.enabled ?? null,
        }),
      };
    }
  }
}
