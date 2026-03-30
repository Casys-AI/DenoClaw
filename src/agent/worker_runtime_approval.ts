import { AgentError } from "../shared/errors.ts";
import type { ApprovalRequest, ApprovalResponse } from "./sandbox_types.ts";
import type { WorkerRequest, WorkerResponse } from "./worker_protocol.ts";

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

export class WorkerApprovalBridge {
  private askPending = new Map<string, {
    resolve: (resp: { approved: boolean; allowAlways?: boolean }) => void;
    reject: (err: Error) => void;
    timer: number;
  }>();

  constructor(
    private readonly respond: (msg: WorkerResponse) => void,
    private readonly getAgentId: () => string,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  ) {}

  askApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.askPending.delete(req.requestId);
        reject(
          new AgentError(
            "APPROVAL_TIMEOUT",
            { binary: req.binary },
            "Approval was not answered in time — denying",
          ),
        );
      }, this.timeoutMs);

      this.askPending.set(req.requestId, {
        resolve: (resp) => {
          clearTimeout(timer);
          this.askPending.delete(req.requestId);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.askPending.delete(req.requestId);
          reject(err);
        },
        timer,
      });

      this.respond({
        type: "ask_approval",
        requestId: req.requestId,
        agentId: this.getAgentId(),
        command: req.command,
        binary: req.binary,
        reason: req.reason,
      });
    });
  }

  handleAskResponse(
    msg: Extract<WorkerRequest, { type: "ask_response" }>,
  ): void {
    const pendingAsk = this.askPending.get(msg.requestId);
    if (!pendingAsk) return;
    pendingAsk.resolve({
      approved: msg.approved,
      allowAlways: msg.allowAlways,
    });
  }

  shutdown(): void {
    for (const pending of this.askPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new AgentError("WORKER_SHUTDOWN", {}, "Worker is shutting down"),
      );
    }
    this.askPending.clear();
  }
}
