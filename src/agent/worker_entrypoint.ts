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
import type { AgentLoopFactoryContext, AgentLoopLike } from "./loop.ts";
import type { AgentResponse } from "./types.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { TraceWriter } from "../telemetry/traces.ts";
import type { ResolvedAgentRegistry } from "./registry.ts";
import type { AgentEntry } from "../shared/types.ts";
import { getAgentDefDir } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  mapLocalTextInputToTask,
  mapTaskErrorToTerminalStatus,
  mapTaskResultToCompletion,
} from "../messaging/a2a/task_mapping.ts";
import { transitionTask } from "../messaging/a2a/internal_contract.ts";
import type {
  WorkerConfig,
  WorkerPeerDeliverRequest,
  WorkerRequest,
  WorkerResponse,
  WorkerRunRequest,
} from "./worker_protocol.ts";
import { createWorkerTaskEventEmitter } from "./worker_runtime_observability.ts";
import { handleWorkerPeerDeliverRequest } from "./worker_runtime_peer_delivery.ts";
import { WorkerPeerMessenger } from "./worker_runtime_peer_messenger.ts";
import { handleWorkerRunRequest } from "./worker_runtime_run.ts";
import { deriveAgentRuntimeCapabilities } from "./runtime_capabilities.ts";
import type { AgentRuntimeCapabilities } from "../shared/runtime_capabilities.ts";

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
 * Exec policy and privilege checks are enforced by runtime policy, not by
 * interactive command approvals.
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

  // Create the loop with canonical context
  const loop = deps.createLoop({
    sessionId: request.sessionId,
    model: request.model,
    traceId: request.traceId,
    taskId,
    contextId,
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
let agentRegistry: ResolvedAgentRegistry = {};
let kvPrivatePath: string | undefined;
let traceWriter: TraceWriter | null = null;
let sharedKv: Deno.Kv | null = null;
let injectedRuntimeCapabilities: AgentRuntimeCapabilities | undefined;
function respond(msg: WorkerResponse): void {
  workerGlobal.postMessage(msg);
}
const taskEvents = createWorkerTaskEventEmitter(respond);
const peerMessenger = new WorkerPeerMessenger(
  respond,
  taskEvents,
  () => agentId,
);

export function resolveEffectiveLoopModel(
  requestedModel?: string,
  entry?: AgentEntry,
): string | undefined {
  return requestedModel ?? entry?.model;
}

// ── BroadcastChannel — shutdown global ───────────────────

const broadcast = new BroadcastChannel("denoclaw");
broadcast.onmessage = (e: MessageEvent) => {
  if (e.data?.type === "shutdown") {
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
): AgentLoop {
  if (!config) {
    throw new AgentError(
      "WORKER_NOT_INITIALIZED",
      { agentId },
      "Worker has not received init message",
    );
  }

  const memory = new KvdexMemory(agentId, sessionId, 100, kvPrivatePath);
  const entry = agentRegistry[agentId];
  const peers = entry?.peers ?? [];
  const sandboxConfig = entry?.sandbox ??
    config.agents.defaults?.sandbox;
  const effectiveModel = resolveEffectiveLoopModel(model, entry);
  const workspaceDir = getAgentDefDir(agentId);
  const runtimeCapabilities = deriveAgentRuntimeCapabilities({
    sandboxConfig,
    availablePeers: peers,
  });
  const effectiveRuntimeCapabilities = injectedRuntimeCapabilities ??
    runtimeCapabilities;
  return new AgentLoop(
    sessionId,
    config,
    effectiveModel ? { model: effectiveModel } : undefined,
    10,
    {
      memory,
      sendToAgent: peerMessenger.createSendToAgent(taskId, contextId, traceId),
      availablePeers: peers,
      sandboxConfig,
      traceWriter: traceWriter ?? undefined,
      traceId,
      taskId,
      contextId,
      agentId,
      workspaceDir,
      runtimeCapabilities: effectiveRuntimeCapabilities,
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
      agentRegistry = msg.agentRegistry;
      injectedRuntimeCapabilities = msg.runtimeCapabilities;
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
      await handleWorkerRunRequest(msg, {
        agentId,
        initialized: config !== null,
        taskEvents,
        respond,
        executeTask: (request, onTaskUpdate) =>
          executeCanonicalWorkerTask(request, {
            createLoop: (ctx) =>
              createAgentLoop(
                ctx.sessionId,
                ctx.model,
                ctx.traceId,
                ctx.taskId,
                ctx.contextId,
              ),
            onTaskUpdate,
          }),
      });
      break;
    }

    case "peer_deliver": {
      await handleWorkerPeerDeliverRequest(msg as WorkerPeerDeliverRequest, {
        agentId,
        initialized: config !== null,
        taskEvents,
        respond,
        processPeerMessage: async (
          sessionId,
          message,
          traceId,
          taskId,
          contextId,
        ) => {
          const loop = createAgentLoop(
            sessionId,
            undefined,
            traceId,
            taskId,
            contextId,
          );
          try {
            const result = await loop.processMessage(message);
            return result.content;
          } finally {
            await loop.close();
          }
        },
      });
      break;
    }

    case "peer_response": {
      peerMessenger.handlePeerResponse(msg);
      break;
    }

    case "shutdown": {
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
