import { AgentError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import type { ToolResult } from "../shared/types.ts";
import type { CronToolPort } from "./tools/cron.ts";
import type { WorkerRequest, WorkerResponse } from "./worker_protocol.ts";

const DEFAULT_CRON_RESPONSE_TIMEOUT_MS = 30_000;

export class WorkerCronMessenger {
  private pending = new Map<string, {
    resolve: (result: ToolResult) => void;
    reject: (error: Error) => void;
    timer: number;
  }>();

  constructor(
    private readonly respond: (msg: WorkerResponse) => void,
    private readonly timeoutMs = DEFAULT_CRON_RESPONSE_TIMEOUT_MS,
  ) {}

  createCronToolPort(): CronToolPort {
    return {
      create: (args) => this.request("create_cron", args),
      list: () => this.request("list_crons", {}),
      delete: (cronJobId) => this.request("delete_cron", { cronJobId }),
    };
  }

  handleCronResponse(msg: Extract<WorkerRequest, { type: "cron_response" }>): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(msg.requestId);
    pending.resolve(msg.result);
  }

  shutdown(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new AgentError("WORKER_SHUTDOWN", {}, "Worker is shutting down"),
      );
    }
    this.pending.clear();
  }

  private request(
    tool: "create_cron" | "list_crons" | "delete_cron",
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const requestId = generateId();

    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AgentError(
            "CRON_TOOL_TIMEOUT",
            { tool },
            `No cron response for "${tool}" within ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      this.respond({
        type: "cron_request",
        requestId,
        tool,
        args,
      });
    });
  }
}
