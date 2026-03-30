import type { WorkerResponse } from "./worker_protocol.ts";

export interface WorkerTaskEventEmitter {
  emitTaskStarted(
    requestId: string,
    sessionId: string,
    traceId?: string,
    taskId?: string,
    contextId?: string,
  ): void;
  emitTaskCompleted(requestId: string): void;
  emitTaskObservation(
    taskId: string,
    from: string,
    to: string,
    message: string,
    status: string,
    result?: string,
    traceId?: string,
    contextId?: string,
  ): void;
}

export function createWorkerTaskEventEmitter(
  respond: (msg: WorkerResponse) => void,
): WorkerTaskEventEmitter {
  return {
    emitTaskStarted(
      requestId,
      sessionId,
      traceId,
      taskId,
      contextId,
    ): void {
      respond({
        type: "task_started",
        requestId,
        sessionId,
        traceId,
        taskId,
        contextId,
      });
    },

    emitTaskCompleted(requestId): void {
      respond({ type: "task_completed", requestId });
    },

    emitTaskObservation(
      taskId,
      from,
      to,
      message,
      status,
      result,
      traceId,
      contextId,
    ): void {
      respond({
        type: "task_observe",
        taskId,
        from,
        to,
        message: message.slice(0, 500),
        status,
        result: result?.slice(0, 500),
        traceId,
        contextId,
      });
    },
  };
}
