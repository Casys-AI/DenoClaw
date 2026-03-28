/**
 * Worker entrypoint — chargé par new Worker().
 * Reçoit config via postMessage "init" et conserve quelques messages bridge
 * pendant la migration, mais l'exécution locale réelle passe désormais par
 * la sémantique canonique de tâche A2A.
 * Supporte la communication inter-agents via le main process (Broker local).
 *
 * Le Worker n'écrit JAMAIS dans le shared KV — il émet des messages au main process
 * qui se charge des écritures. Cela rend le Worker transport-agnostic (deploy-compatible).
 *
 * Task 3.2: All local worker execution now routes through canonical A2A task semantics
 * via executeCanonicalWorkerTask(). The legacy "process" message is only a narrow
 * compatibility bridge into that canonical path.
 */

import { AgentLoop } from "./loop.ts";
import type { AgentLoopLike, AgentLoopFactoryContext, AskApprovalFn } from "./loop.ts";
import type { AgentResponse } from "./types.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { TraceWriter } from "../telemetry/traces.ts";
import { generateId } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import type { ApprovalRequest, ApprovalResponse } from "../shared/types.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  mapLocalTextInputToTask,
  mapTaskResultToCompletion,
  mapTaskErrorToTerminalStatus,
  mapApprovalPauseToInputRequiredTask,
} from "../messaging/a2a/task_mapping.ts";
import { transitionTask } from "../messaging/a2a/internal_contract.ts";
import type {
  WorkerConfig,
  WorkerRequest,
  WorkerResponse,
} from "./worker_protocol.ts";

// ── Canonical A2A task execution (Task 3.2) ──────────────

/**
 * Minimal request shape for canonical task execution.
 * Maps directly from the worker protocol "process" message.
 */
export type CanonicalWorkerTaskRequest = Extract<
  WorkerRequest,
  { type: "process" }
>;

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
 * Result of canonical task execution — carries both the A2A task
 * and the original AgentResponse for backward compatibility.
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
function respond(msg: WorkerResponse): void {
  workerGlobal.postMessage(msg);
}

// ── Observability — emit to main process (no direct KV writes) ──

function emitTaskStarted(
  requestId: string,
  sessionId: string,
  traceId?: string,
  taskId?: string,
  contextId?: string,
): void {
  respond({ type: "task_started", requestId, sessionId, traceId, taskId, contextId });
}

function emitTaskCompleted(requestId: string): void {
  respond({ type: "task_completed", requestId });
}

function emitAgentTask(
  taskId: string,
  from: string,
  to: string,
  message: string,
  status: string,
  result?: string,
  traceId?: string,
  contextId?: string,
): void {
  respond({
    type: "agent_task",
    taskId,
    from,
    to,
    message: message.slice(0, 500),
    status,
    result: result?.slice(0, 500),
    traceId,
    contextId,
  });
}

// ── Ask approval pending requests (ADR-010) ──

const APPROVAL_TIMEOUT_MS = 60_000;

const askPending = new Map<string, {
  resolve: (resp: { approved: boolean; allowAlways?: boolean }) => void;
  reject: (err: Error) => void;
  timer: number;
}>();

function askApproval(
  req: ApprovalRequest,
): Promise<ApprovalResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      askPending.delete(req.requestId);
      reject(
        new AgentError(
          "APPROVAL_TIMEOUT",
          { binary: req.binary },
          "Approval was not answered in time — denying",
        ),
      );
    }, APPROVAL_TIMEOUT_MS);

    askPending.set(req.requestId, {
      resolve: (resp) => {
        clearTimeout(timer);
        askPending.delete(req.requestId);
        resolve(resp);
      },
      reject: (err) => {
        clearTimeout(timer);
        askPending.delete(req.requestId);
        reject(err);
      },
      timer,
    });

    respond({
      type: "ask_approval",
      requestId: req.requestId,
      agentId,
      command: req.command,
      binary: req.binary,
      reason: req.reason,
    });
  });
}

function drainAskPending(): void {
  for (const [, pending] of askPending) {
    clearTimeout(pending.timer);
    pending.reject(
      new AgentError("WORKER_SHUTDOWN", {}, "Worker is shutting down"),
    );
  }
  askPending.clear();
}

// ── Agent message pending requests (attente réponse d'un autre agent) ──

const agentPending = new Map<string, {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}>();

function createSendToAgent(
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
        agentPending.delete(requestId);
        reject(
          new AgentError(
            "AGENT_MSG_TIMEOUT",
            { toAgent },
            `No response from "${toAgent}" within 120s`,
          ),
        );
      }, 120_000);

      agentPending.set(requestId, {
        resolve: (content: string) => {
          clearTimeout(timer);
          agentPending.delete(requestId);
          resolve(content);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          agentPending.delete(requestId);
          reject(err);
        },
      });

      respond({
        type: "agent_send",
        requestId,
        toAgent,
        message,
        traceId,
        taskId: delegatedTaskId,
        contextId: delegatedContextId,
      });
      emitAgentTask(
        delegatedTaskId,
        agentId,
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

// ── BroadcastChannel — shutdown global ───────────────────

const broadcast = new BroadcastChannel("denoclaw");
broadcast.onmessage = (e: MessageEvent) => {
  if (e.data?.type === "shutdown") {
    drainAskPending();
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
  return new AgentLoop(
    sessionId,
    config,
    model ? { model } : undefined,
    10,
    {
      memory,
      sendToAgent: createSendToAgent(taskId, contextId, traceId),
      availablePeers: peers,
      sandboxConfig,
      askApproval: overrideAskApproval ?? askApproval,
      traceWriter: traceWriter ?? undefined,
      traceId,
      taskId,
      contextId,
      agentId,
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
        const sharedKv = await Deno.openKv(msg.kvPaths.shared);
        traceWriter = new TraceWriter(sharedKv);
      } catch (e) {
        log.warn("Shared KV unavailable — tracing disabled", e instanceof Error ? e.message : String(e));
      }
      respond({ type: "ready", agentId });
      break;
    }

    case "process": {
      if (!config) {
        respond({
          type: "error",
          requestId: msg.requestId,
          code: "WORKER_NOT_INITIALIZED",
          message: "Worker has not received init message",
        });
        break;
      }

      // Task 3.2: Route through canonical A2A task execution path.
      // The legacy observability hooks (emitTaskStarted/Completed) are preserved
      // as a compatibility bridge; they will be replaced by task lifecycle events.
      const traceId = msg.traceId;
      const taskId = msg.taskId ?? msg.requestId;
      const contextId = msg.contextId ?? taskId;
      emitTaskStarted(msg.requestId, msg.sessionId, traceId, taskId, contextId);

      try {
        const result = await executeCanonicalWorkerTask(
          {
            type: "process",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            message: msg.message,
            model: msg.model,
            traceId: msg.traceId,
            taskId,
            contextId,
          },
          {
            createLoop: (ctx) => createAgentLoop(
              ctx.sessionId,
              ctx.model,
              ctx.traceId,
              ctx.taskId,
              ctx.contextId,
              ctx.askApproval,
            ),
            askApproval,
            onTaskUpdate: (task) => {
              emitAgentTask(
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
            type: "result",
            requestId: msg.requestId,
            content: result.response.content,
            finishReason: result.response.finishReason,
          });
        } else {
          respond({
            type: "error",
            requestId: msg.requestId,
            code: result.error?.code ?? "AGENT_ERROR",
            message: result.error?.message ?? "Unknown error",
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        respond({
          type: "error",
          requestId: msg.requestId,
          code: "AGENT_ERROR",
          message,
        });
      } finally {
        emitTaskCompleted(msg.requestId);
      }
      break;
    }

    case "agent_deliver": {
      const traceId = msg.traceId;
      const taskId = msg.taskId ?? msg.requestId;
      const contextId = msg.contextId ?? taskId;
      emitTaskStarted(
        msg.requestId,
        `agent:${msg.fromAgent}:${agentId}`,
        traceId,
        taskId,
        contextId,
      );
      emitAgentTask(
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
        emitAgentTask(
          taskId,
          msg.fromAgent,
          agentId,
          msg.message,
          "failed",
          "Worker not initialized",
          traceId,
          contextId,
        );
        emitTaskCompleted(msg.requestId);
        respond({
          type: "agent_result",
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
          emitAgentTask(
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
            type: "agent_result",
            requestId: msg.requestId,
            content: result.content,
          });
        } finally {
          await loop.close();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        emitAgentTask(
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
          type: "agent_result",
          requestId: msg.requestId,
          content: errMsg,
          error: true,
        });
      } finally {
        emitTaskCompleted(msg.requestId);
      }
      break;
    }

    case "agent_response": {
      const pending = agentPending.get(msg.requestId);
      if (pending) {
        if (msg.error) {
          pending.reject(
            new AgentError(
              "AGENT_MSG_REJECTED",
              { content: msg.content },
              msg.content,
            ),
          );
        } else {
          pending.resolve(msg.content);
        }
      }
      break;
    }

    case "ask_response": {
      const pendingAsk = askPending.get(msg.requestId);
      if (pendingAsk) {
        pendingAsk.resolve({
          approved: msg.approved,
          allowAlways: msg.allowAlways,
        });
      }
      break;
    }

    case "shutdown": {
      drainAskPending();
      broadcast.close();
      workerGlobal.close();
      break;
    }
  }
};
