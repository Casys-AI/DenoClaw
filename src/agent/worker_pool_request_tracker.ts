import type { AgentResponse } from "./types.ts";
import type { WorkerResponse } from "./worker_protocol.ts";
import { AgentError } from "../shared/errors.ts";

interface PendingRequest {
  resolve: (value: AgentResponse) => void;
  reject: (reason: Error) => void;
  timer: number;
}

type WorkerRunResultMessage = Extract<WorkerResponse, { type: "run_result" }>;
type WorkerRunErrorMessage = Extract<WorkerResponse, { type: "run_error" }>;

export class WorkerPoolRequestTracker {
  private pending = new Map<string, PendingRequest>();

  createRunRequest(
    requestId: string,
    agentId: string,
    timeoutMs: number,
  ): Promise<AgentResponse> {
    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AgentError("WORKER_TIMEOUT", {
            agentId,
            timeoutMs,
          }, "Increase timeout or check agent health"),
        );
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  resolveRunResult(msg: WorkerRunResultMessage): boolean {
    const req = this.pending.get(msg.requestId);
    if (!req) return false;
    clearTimeout(req.timer);
    this.pending.delete(msg.requestId);
    req.resolve({ content: msg.content, finishReason: msg.finishReason });
    return true;
  }

  rejectRunError(msg: WorkerRunErrorMessage): boolean {
    const req = this.pending.get(msg.requestId);
    if (!req) return false;
    clearTimeout(req.timer);
    this.pending.delete(msg.requestId);
    req.reject(
      new AgentError(
        msg.code,
        { message: msg.message },
        "Check agent logs",
      ),
    );
    return true;
  }

  shutdown(): void {
    const snapshot = [...this.pending.values()];
    this.pending.clear();
    for (const req of snapshot) {
      clearTimeout(req.timer);
      req.reject(
        new AgentError(
          "WORKER_POOL_SHUTDOWN",
          {},
          "WorkerPool is shutting down",
        ),
      );
    }
  }
}
