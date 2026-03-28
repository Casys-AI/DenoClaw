/**
 * Worker entrypoint — chargé par new Worker().
 * Reçoit config via postMessage "init", traite les messages via "process".
 * Supporte la communication inter-agents via le main process (Broker local).
 *
 * Le Worker n'écrit JAMAIS dans le shared KV — il émet des messages au main process
 * qui se charge des écritures. Cela rend le Worker transport-agnostic (deploy-compatible).
 */

import { AgentLoop } from "./loop.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { TraceWriter } from "../telemetry/traces.ts";
import { generateId } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import type {
  WorkerConfig,
  WorkerRequest,
  WorkerResponse,
} from "./worker_protocol.ts";

let agentId = "default";
let config: WorkerConfig | null = null;
let kvPrivatePath: string | undefined;
let traceWriter: TraceWriter | null = null;
function respond(msg: WorkerResponse): void {
  self.postMessage(msg);
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
  req: { requestId: string; command: string; binary: string; reason: string },
): Promise<{ approved: boolean; allowAlways?: boolean }> {
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
    self.close();
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
      askApproval,
      traceWriter: traceWriter ?? undefined,
      traceId,
      taskId,
      contextId,
      agentId,
    },
  );
}

// ── Message handler ──────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
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
      } catch { /* shared KV not available — tracing disabled */ }
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

      const traceId = msg.traceId;
      const taskId = msg.taskId ?? msg.requestId;
      const contextId = msg.contextId ?? taskId;
      emitTaskStarted(msg.requestId, msg.sessionId, traceId, taskId, contextId);

      try {
        const loop = createAgentLoop(
          msg.sessionId,
          msg.model,
          msg.traceId,
          taskId,
          contextId,
        );
        try {
          const result = await loop.processMessage(msg.message);
          respond({
            type: "result",
            requestId: msg.requestId,
            content: result.content,
            finishReason: result.finishReason,
          });
        } finally {
          await loop.close();
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
      self.close();
      break;
    }
  }
};
