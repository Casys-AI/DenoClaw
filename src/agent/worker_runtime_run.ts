import type { AgentResponse } from "./types.ts";
import type { Task } from "../messaging/a2a/types.ts";
import type { WorkerResponse, WorkerRunRequest } from "./worker_protocol.ts";
import type { WorkerTaskEventEmitter } from "./worker_runtime_observability.ts";

export interface WorkerRunHandlerDeps {
  agentId: string;
  initialized: boolean;
  taskEvents: WorkerTaskEventEmitter;
  respond(msg: WorkerResponse): void;
  executeTask(
    request: WorkerRunRequest & { taskId: string; contextId: string },
    onTaskUpdate: (task: Task) => void,
  ): Promise<{
    response?: AgentResponse;
    error?: { code: string; message: string };
  }>;
}

export async function handleWorkerRunRequest(
  msg: WorkerRunRequest,
  deps: WorkerRunHandlerDeps,
): Promise<void> {
  if (!deps.initialized) {
    deps.respond({
      type: "run_error",
      requestId: msg.requestId,
      code: "WORKER_NOT_INITIALIZED",
      message: "Worker has not received init message",
      recovery: "Ensure the worker receives an init message before run requests",
    });
    return;
  }

  const traceId = msg.traceId;
  const taskId = msg.taskId ?? msg.requestId;
  const contextId = msg.contextId ?? taskId;
  deps.taskEvents.emitTaskStarted(
    msg.requestId,
    msg.sessionId,
    traceId,
    taskId,
    contextId,
  );

  try {
    const result = await deps.executeTask(
      {
        ...msg,
        taskId,
        contextId,
      },
      (task) => {
        deps.taskEvents.emitTaskObservation(
          task.id,
          deps.agentId,
          deps.agentId,
          msg.message.slice(0, 200),
          task.status.state.toLowerCase(),
          undefined,
          traceId,
          task.contextId,
        );
      },
    );

    if (result.response) {
      deps.respond({
        type: "run_result",
        requestId: msg.requestId,
        content: result.response.content,
        finishReason: result.response.finishReason,
      });
      return;
    }

    deps.respond({
      type: "run_error",
      requestId: msg.requestId,
      code: result.error?.code ?? "AGENT_ERROR",
      message: result.error?.message ?? "Unknown error",
      recovery: "Check agent configuration and LLM provider availability",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.respond({
      type: "run_error",
      requestId: msg.requestId,
      code: "AGENT_ERROR",
      message,
      recovery: "Check agent logs and retry the request",
    });
  } finally {
    deps.taskEvents.emitTaskCompleted(msg.requestId);
  }
}
