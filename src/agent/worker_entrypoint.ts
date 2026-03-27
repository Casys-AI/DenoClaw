/**
 * Worker entrypoint — chargé par new Worker().
 * Reçoit config via postMessage "init", traite les messages via "process".
 * Supporte la communication inter-agents via le main process (Broker local).
 *
 * Le Worker n'écrit JAMAIS dans le shared KV — il émet des messages au main process
 * qui se charge des écritures. Cela rend le Worker transport-agnostic (deploy-compatible).
 */

import { AgentLoop } from "./loop.ts";
import { Memory } from "./memory.ts";
import { generateId } from "../shared/helpers.ts";
import { AgentError } from "../shared/errors.ts";
import type { WorkerConfig, WorkerRequest, WorkerResponse } from "./worker_protocol.ts";

let agentId = "default";
let config: WorkerConfig | null = null;
let kvPrivatePath: string | undefined;
let currentTraceId: string | undefined;

function respond(msg: WorkerResponse): void {
  self.postMessage(msg);
}

// ── Observability — emit to main process (no direct KV writes) ──

function emitTaskStarted(requestId: string, sessionId: string): void {
  respond({ type: "task_started", requestId, sessionId, traceId: currentTraceId });
}

function emitTaskCompleted(requestId: string): void {
  respond({ type: "task_completed", requestId });
}

function emitAgentTask(taskId: string, from: string, to: string, message: string, status: string, result?: string): void {
  respond({
    type: "agent_task",
    taskId, from, to,
    message: message.slice(0, 500),
    status,
    result: result?.slice(0, 500),
    traceId: currentTraceId,
  });
}

// ── Agent message pending requests (attente réponse d'un autre agent) ──

const agentPending = new Map<string, {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}>();

function sendToAgent(toAgent: string, message: string): Promise<string> {
  const requestId = generateId();

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      agentPending.delete(requestId);
      reject(new AgentError("AGENT_MSG_TIMEOUT", { toAgent }, `No response from "${toAgent}" within 120s`));
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

    respond({ type: "agent_send", requestId, toAgent, message, traceId: currentTraceId });
    emitAgentTask(requestId, agentId, toAgent, message, "sent");
  });
}

// ── BroadcastChannel — shutdown global ───────────────────

const broadcast = new BroadcastChannel("denoclaw");
broadcast.onmessage = (e: MessageEvent) => {
  if (e.data?.type === "shutdown") {
    broadcast.close();
    self.close();
  }
};

// ── Helpers ──────────────────────────────────────────────

function createAgentLoop(sessionId: string, model?: string): AgentLoop {
  if (!config) throw new AgentError("WORKER_NOT_INITIALIZED", { agentId }, "Worker has not received init message");

  const memory = new Memory(sessionId, 100, kvPrivatePath);
  return new AgentLoop(
    sessionId,
    config,
    model ? { model } : undefined,
    10,
    { memory, sendToAgent },
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

      currentTraceId = msg.traceId;
      emitTaskStarted(msg.requestId, msg.sessionId);

      try {
        const loop = createAgentLoop(msg.sessionId, msg.model);
        try {
          const result = await loop.processMessage(msg.message);
          respond({
            type: "result",
            requestId: msg.requestId,
            content: result.content,
            finishReason: result.finishReason,
          });
        } finally {
          loop.close();
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
        currentTraceId = undefined;
      }
      break;
    }

    case "agent_deliver": {
      currentTraceId = msg.traceId;
      emitTaskStarted(msg.requestId, `agent-${msg.fromAgent}-${agentId}`);
      emitAgentTask(msg.requestId, msg.fromAgent, agentId, msg.message, "received");

      if (!config) {
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
        const sessionId = `agent-${msg.fromAgent}-${agentId}`;
        const loop = createAgentLoop(sessionId);
        try {
          const result = await loop.processMessage(
            `[Message from agent "${msg.fromAgent}"]: ${msg.message}`,
          );
          emitAgentTask(msg.requestId, msg.fromAgent, agentId, msg.message, "completed", result.content);
          respond({
            type: "agent_result",
            requestId: msg.requestId,
            content: result.content,
          });
        } finally {
          loop.close();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        emitAgentTask(msg.requestId, msg.fromAgent, agentId, msg.message, "failed", errMsg);
        respond({
          type: "agent_result",
          requestId: msg.requestId,
          content: errMsg,
          error: true,
        });
      } finally {
        emitTaskCompleted(msg.requestId);
        currentTraceId = undefined;
      }
      break;
    }

    case "agent_response": {
      const pending = agentPending.get(msg.requestId);
      if (pending) {
        if (msg.error) {
          pending.reject(new AgentError("AGENT_MSG_REJECTED", { content: msg.content }, msg.content));
        } else {
          pending.resolve(msg.content);
        }
      }
      break;
    }

    case "shutdown": {
      broadcast.close();
      self.close();
      break;
    }
  }
};
