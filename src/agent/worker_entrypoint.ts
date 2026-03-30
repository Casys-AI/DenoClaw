/**
 * Worker entrypoint — loaded by `new Worker()`.
 * Receives config via `init` and executes local work through a strict internal
 * runtime protocol, while canonical task semantics remain carried by A2A.
 * Supports inter-agent communication through the main process (local Broker).
 *
 * The Worker NEVER writes directly to shared KV — it emits messages to the main
 * process, which performs the writes. This keeps the Worker transport-agnostic
 * (deploy-compatible).
 *
 * All local worker execution routes through canonical A2A task semantics via
 * executeCanonicalWorkerTask(). The worker protocol remains runtime plumbing only.
 */

import { AgentLoop } from "./loop.ts";
import type {
  AgentLoopFactoryContext,
  AgentLoopLike,
  AskApprovalFn,
} from "./loop.ts";
import type { AgentResponse } from "./types.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { TraceWriter } from "../telemetry/traces.ts";
import { getAgentDefDir } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import type { ApprovalRequest, ApprovalResponse } from "./sandbox_types.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  mapApprovalPauseToInputRequiredTask,
  mapLocalTextInputToTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../messaging/a2a/task_mapping.ts";
import { transitionTask } from "../messaging/a2a/internal_contract.ts";
import type {
  WorkerConfig,
  WorkerRequest,
  WorkerResponse,
  WorkerRunRequest,
} from "./worker_protocol.ts";
import { createWorkerTaskEventEmitter } from "./worker_runtime_observability.ts";
import { WorkerApprovalBridge } from "./worker_runtime_approval.ts";
import { WorkerPeerMessenger } from "./worker_runtime_peer_messenger.ts";

// ── Canonical A2A task execution (Task 3.2) ──────────────

/**
 * Minimal request shape for canonical task execution.
 * Maps directly from the worker protocol `run` message.
 */
export type CanonicalWorkerTaskRequest = WorkerRunRequest;

/**
 * Dependencies injected into executeCanonicalWorkerTask.
 * Decoupled from Worker globals for testability.
 */
export interface CanonicalWorkerTaskDeps {
  createLoop: (ctx: AgentLoopFactoryContext) => AgentLoopLike;
  onTaskUpdate?: (task: Task) => void;
  askApproval?: AskApprovalFn;
}

/**
 * Result of canonical task execution — carries the canonical A2A task
 * plus the caller-facing AgentResponse projection.
 */
export interface CanonicalWorkerTaskResult {
  task: Task;
  response?: AgentResponse;
  error?: { code: string; message: string };
}

/**
 * Execute a local worker request through canonical A2A task semantics.
 *
 * This is the single execution path for all local worker tasks.
 * It wraps AgentLoop (or any AgentLoopLike) inside the canonical
 * task lifecycle: SUBMITTED → WORKING → terminal state.
 *
 * Approval pauses surface as INPUT_REQUIRED in the task lifecycle
 * and are transported via the injected askApproval callback.
 */
export async function executeCanonicalWorkerTask(
  request: CanonicalWorkerTaskRequest,
  deps: CanonicalWorkerTaskDeps,
): Promise<CanonicalWorkerTaskResult> {
  const taskId = request.taskId ?? request.requestId;
  const contextId = request.contextId ?? request.sessionId;

  // Phase 1: SUBMITTED
  let task = mapLocalTextInputToTask({
    requestId: request.requestId,
    sessionId: request.sessionId,
    message: request.message,
    taskId,
    contextId,
  });
  deps.onTaskUpdate?.(task);

  // Phase 2: WORKING
  task = transitionTask(task, "WORKING");
  deps.onTaskUpdate?.(task);

  // Build approval wrapper that surfaces pauses in A2A lifecycle
  const wrappedAskApproval: AskApprovalFn | undefined = deps.askApproval
    ? async (req: ApprovalRequest): Promise<ApprovalResponse> => {
      // Transition to INPUT_REQUIRED
      task = mapApprovalPauseToInputRequiredTask(task, {
        command: req.command,
        binary: req.binary,
        prompt: `Awaiting approval for ${req.binary}: ${req.command}`,
        continuationToken: req.requestId,
      });
      deps.onTaskUpdate?.(task);

      // Transport the approval request
      const response = await deps.askApproval!(req);

      // Resume to WORKING
      task = transitionTask(task, "WORKING");
      deps.onTaskUpdate?.(task);

      return response;
    }
    : undefined;

  // Create the loop with canonical context
  const loop = deps.createLoop({
    sessionId: request.sessionId,
    model: request.model,
    traceId: request.traceId,
    taskId,
    contextId,
    askApproval: wrappedAskApproval,
  });

  try {
    const response = await loop.processMessage(request.message);

    // Phase 3: COMPLETED
    task = mapTaskResultToCompletion(task, response.content);
    deps.onTaskUpdate?.(task);

    return { task, response };
  } catch (err) {
    // Phase 3: FAILED or REJECTED
    task = mapTaskErrorToTerminalStatus(task, err);
    deps.onTaskUpdate?.(task);

    const message = err instanceof Error ? err.message : String(err);
    return { task, error: { code: "AGENT_ERROR", message } };
  } finally {
    await loop.close();
  }
}

const workerGlobal = globalThis as typeof globalThis & {
  postMessage: (msg: WorkerResponse) => void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void | Promise<void>) | null;
  close: () => void;
};

let agentId = "default";
let config: WorkerConfig | null = null;
let kvPrivatePath: string | undefined;
let traceWriter: TraceWriter | null = null;
let sharedKv: Deno.Kv | null = null;
function respond(msg: WorkerResponse): void {
  workerGlobal.postMessage(msg);
}
const taskEvents = createWorkerTaskEventEmitter(respond);
const approvalBridge = new WorkerApprovalBridge(respond, () => agentId);
const peerMessenger = new WorkerPeerMessenger(
  respond,
  taskEvents,
  () => agentId,
);

// ── BroadcastChannel — shutdown global ───────────────────

const broadcast = new BroadcastChannel("denoclaw");
broadcast.onmessage = (e: MessageEvent) => {
  if (e.data?.type === "shutdown") {
    approvalBridge.shutdown();
    peerMessenger.shutdown();
    if (sharedKv) {
      sharedKv.close();
      sharedKv = null;
    }
    broadcast.close();
    workerGlobal.close();
  }
};

// ── Helpers ──────────────────────────────────────────────

function createAgentLoop(
  sessionId: string,
  model?: string,
  traceId?: string,
  taskId?: string,
  contextId?: string,
  overrideAskApproval?: AskApprovalFn,
): AgentLoop {
  if (!config) {
    throw new AgentError(
      "WORKER_NOT_INITIALIZED",
      { agentId },
      "Worker has not received init message",
    );
  }

  const memory = new KvdexMemory(agentId, sessionId, 100, kvPrivatePath);
  const peers = config.agents.registry?.[agentId]?.peers ?? [];
  const sandboxConfig = config.agents.registry?.[agentId]?.sandbox ??
    config.agents.defaults?.sandbox;
  const workspaceDir = getAgentDefDir(agentId);
  return new AgentLoop(
    sessionId,
    config,
    model ? { model } : undefined,
    10,
    {
      memory,
      sendToAgent: peerMessenger.createSendToAgent(taskId, contextId, traceId),
      availablePeers: peers,
      sandboxConfig,
      askApproval: overrideAskApproval ?? ((req) => approvalBridge.askApproval(req)),
      traceWriter: traceWriter ?? undefined,
      traceId,
      taskId,
      contextId,
      agentId,
      workspaceDir,
    },
  );
}

// ── Message handler ──────────────────────────────────────

workerGlobal.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      agentId = msg.agentId;
      config = msg.config;
      kvPrivatePath = msg.kvPaths.private;
      // Open shared KV for trace writing (best-effort observability)
      try {
        sharedKv = await Deno.openKv(msg.kvPaths.shared);
        traceWriter = new TraceWriter(sharedKv);
      } catch (e) {
        log.warn(
          "Shared KV unavailable — tracing disabled",
          e instanceof Error ? e.message : String(e),
        );
      }
      respond({ type: "ready", agentId });
      break;
    }

    case "run": {
      if (!config) {
        respond({
          type: "run_error",
          requestId: msg.requestId,
          code: "WORKER_NOT_INITIALIZED",
          message: "Worker has not received init message",
        });
        break;
      }

      const traceId = msg.traceId;
      const taskId = msg.taskId ?? msg.requestId;
      const contextId = msg.contextId ?? taskId;
      taskEvents.emitTaskStarted(
        msg.requestId,
        msg.sessionId,
        traceId,
        taskId,
        contextId,
      );

      try {
        const result = await executeCanonicalWorkerTask(
          {
            type: "run",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            message: msg.message,
            model: msg.model,
            traceId: msg.traceId,
            taskId,
            contextId,
          },
          {
            createLoop: (ctx) =>
              createAgentLoop(
                ctx.sessionId,
                ctx.model,
                ctx.traceId,
                ctx.taskId,
                ctx.contextId,
                ctx.askApproval,
              ),
            askApproval: (req) => approvalBridge.askApproval(req),
            onTaskUpdate: (task) => {
              taskEvents.emitTaskObservation(
                task.id,
                agentId,
                agentId,
                msg.message.slice(0, 200),
                task.status.state.toLowerCase(),
                undefined,
                traceId,
                task.contextId,
              );
            },
          },
        );

        if (result.response) {
          respond({
            type: "run_result",
            requestId: msg.requestId,
            content: result.response.content,
            finishReason: result.response.finishReason,
          });
        } else {
          respond({
            type: "run_error",
            requestId: msg.requestId,
            code: result.error?.code ?? "AGENT_ERROR",
            message: result.error?.message ?? "Unknown error",
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respond({
          type: "run_error",
          requestId: msg.requestId,
          code: "AGENT_ERROR",
          message,
        });
      } finally {
        taskEvents.emitTaskCompleted(msg.requestId);
      }
      break;
    }

    case "peer_deliver": {
      const traceId = msg.traceId;
      const taskId = msg.taskId ?? msg.requestId;
      const contextId = msg.contextId ?? taskId;
      taskEvents.emitTaskStarted(
        msg.requestId,
        `agent:${msg.fromAgent}:${agentId}`,
        traceId,
        taskId,
        contextId,
      );
      taskEvents.emitTaskObservation(
        taskId,
        msg.fromAgent,
        agentId,
        msg.message,
        "received",
        undefined,
        traceId,
        contextId,
      );

      if (!config) {
        taskEvents.emitTaskObservation(
          taskId,
          msg.fromAgent,
          agentId,
          msg.message,
          "failed",
          "Worker not initialized",
          traceId,
          contextId,
        );
        taskEvents.emitTaskCompleted(msg.requestId);
        respond({
          type: "peer_result",
          requestId: msg.requestId,
          content: "Worker not initialized",
          error: true,
        });
        break;
      }

      try {
        const sessionId = `agent:${msg.fromAgent}:${agentId}`;
        const loop = createAgentLoop(
          sessionId,
          undefined,
          msg.traceId,
          taskId,
          contextId,
        );
        try {
          const result = await loop.processMessage(
            `[Message from agent "${msg.fromAgent}"]: ${msg.message}`,
          );
          taskEvents.emitTaskObservation(
            taskId,
            msg.fromAgent,
            agentId,
            msg.message,
            "completed",
            result.content,
            traceId,
            contextId,
          );
          respond({
            type: "peer_result",
            requestId: msg.requestId,
            content: result.content,
          });
        } finally {
          await loop.close();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        taskEvents.emitTaskObservation(
          taskId,
          msg.fromAgent,
          agentId,
          msg.message,
          "failed",
          errMsg,
          traceId,
          contextId,
        );
        respond({
          type: "peer_result",
          requestId: msg.requestId,
          content: errMsg,
          error: true,
        });
      } finally {
        taskEvents.emitTaskCompleted(msg.requestId);
      }
      break;
    }

    case "peer_response": {
      peerMessenger.handlePeerResponse(msg);
      break;
    }

    case "ask_response": {
      approvalBridge.handleAskResponse(msg);
      break;
    }

    case "shutdown": {
      approvalBridge.shutdown();
      peerMessenger.shutdown();
      if (sharedKv) {
        sharedKv.close();
        sharedKv = null;
      }
      broadcast.close();
      workerGlobal.close();
      break;
    }
  }
};
