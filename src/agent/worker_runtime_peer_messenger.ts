import { AgentError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import type { WorkerRequest, WorkerResponse } from "./worker_protocol.ts";
import type { WorkerTaskEventEmitter } from "./worker_runtime_observability.ts";

const DEFAULT_PEER_RESPONSE_TIMEOUT_MS = 120_000;

export class WorkerPeerMessenger {
  private agentPending = new Map<string, {
    resolve: (content: string) => void;
    reject: (err: Error) => void;
    timer: number;
  }>();

  constructor(
    private readonly respond: (msg: WorkerResponse) => void,
    private readonly events: WorkerTaskEventEmitter,
    private readonly getAgentId: () => string,
    private readonly timeoutMs = DEFAULT_PEER_RESPONSE_TIMEOUT_MS,
  ) {}

  createSendToAgent(
    taskId?: string,
    contextId?: string,
    traceId?: string,
  ): (toAgent: string, message: string) => Promise<string> {
    return (toAgent: string, message: string): Promise<string> => {
      const requestId = generateId();
      const delegatedTaskId = taskId ?? requestId;
      const delegatedContextId = contextId ?? taskId ?? requestId;

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.agentPending.delete(requestId);
          reject(
            new AgentError(
              "AGENT_MSG_TIMEOUT",
              { toAgent },
              `No response from "${toAgent}" within 120s`,
            ),
          );
        }, this.timeoutMs);

        this.agentPending.set(requestId, {
          resolve: (content: string) => {
            clearTimeout(timer);
            this.agentPending.delete(requestId);
            resolve(content);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            this.agentPending.delete(requestId);
            reject(err);
          },
          timer,
        });

        this.respond({
          type: "peer_send",
          requestId,
          toAgent,
          message,
          traceId,
          taskId: delegatedTaskId,
          contextId: delegatedContextId,
        });
        this.events.emitTaskObservation(
          delegatedTaskId,
          this.getAgentId(),
          toAgent,
          message,
          "sent",
          undefined,
          traceId,
          delegatedContextId,
        );
      });
    };
  }

  handlePeerResponse(
    msg: Extract<WorkerRequest, { type: "peer_response" }>,
  ): void {
    const pending = this.agentPending.get(msg.requestId);
    if (!pending) return;
    if (msg.error) {
      pending.reject(
        new AgentError(
          "AGENT_MSG_REJECTED",
          { content: msg.content },
          msg.content,
        ),
      );
      return;
    }
    pending.resolve(msg.content);
  }

  shutdown(): void {
    for (const pending of this.agentPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new AgentError("WORKER_SHUTDOWN", {}, "Worker is shutting down"),
      );
    }
    this.agentPending.clear();
  }
}
