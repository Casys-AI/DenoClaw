import type {
  WorkerPeerDeliverRequest,
  WorkerResponse,
} from "./worker_protocol.ts";
import type { WorkerTaskEventEmitter } from "./worker_runtime_observability.ts";

export interface WorkerPeerDeliveryHandlerDeps {
  agentId: string;
  initialized: boolean;
  taskEvents: WorkerTaskEventEmitter;
  respond(msg: WorkerResponse): void;
  processPeerMessage(
    sessionId: string,
    message: string,
    traceId: string | undefined,
    taskId: string,
    contextId: string,
  ): Promise<string>;
}

export async function handleWorkerPeerDeliverRequest(
  msg: WorkerPeerDeliverRequest,
  deps: WorkerPeerDeliveryHandlerDeps,
): Promise<void> {
  const traceId = msg.traceId;
  const taskId = msg.taskId ?? msg.requestId;
  const contextId = msg.contextId ?? taskId;
  deps.taskEvents.emitTaskStarted(
    msg.requestId,
    `agent:${msg.fromAgent}:${deps.agentId}`,
    traceId,
    taskId,
    contextId,
  );
  deps.taskEvents.emitTaskObservation(
    taskId,
    msg.fromAgent,
    deps.agentId,
    msg.message,
    "received",
    undefined,
    traceId,
    contextId,
  );

  if (!deps.initialized) {
    deps.taskEvents.emitTaskObservation(
      taskId,
      msg.fromAgent,
      deps.agentId,
      msg.message,
      "failed",
      "Worker not initialized",
      traceId,
      contextId,
    );
    deps.taskEvents.emitTaskCompleted(msg.requestId);
    deps.respond({
      type: "peer_result",
      requestId: msg.requestId,
      content: "Worker not initialized",
      error: true,
    });
    return;
  }

  try {
    const result = await deps.processPeerMessage(
      `agent:${msg.fromAgent}:${deps.agentId}`,
      `[Message from agent "${msg.fromAgent}"]: ${msg.message}`,
      msg.traceId,
      taskId,
      contextId,
    );
    deps.taskEvents.emitTaskObservation(
      taskId,
      msg.fromAgent,
      deps.agentId,
      msg.message,
      "completed",
      result,
      traceId,
      contextId,
    );
    deps.respond({
      type: "peer_result",
      requestId: msg.requestId,
      content: result,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    deps.taskEvents.emitTaskObservation(
      taskId,
      msg.fromAgent,
      deps.agentId,
      msg.message,
      "failed",
      errMsg,
      traceId,
      contextId,
    );
    deps.respond({
      type: "peer_result",
      requestId: msg.requestId,
      content: errMsg,
      error: true,
    });
  } finally {
    deps.taskEvents.emitTaskCompleted(msg.requestId);
  }
}
