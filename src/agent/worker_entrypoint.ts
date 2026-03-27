/**
 * Worker entrypoint — chargé par new Worker().
 * Reçoit config via postMessage "init", traite les messages via "process".
 * Même AgentLoop que le mode in-process, juste isolé dans un Worker.
 */

import { AgentLoop } from "./loop.ts";
import { Memory } from "./memory.ts";
import type { WorkerConfig, WorkerRequest, WorkerResponse } from "./worker_protocol.ts";

let agentId = "default";
let config: WorkerConfig | null = null;
let kvPrivatePath: string | undefined;

function respond(msg: WorkerResponse): void {
  self.postMessage(msg);
}

// ── BroadcastChannel — shutdown global ───────────────────

const broadcast = new BroadcastChannel("denoclaw");
broadcast.onmessage = (e: MessageEvent) => {
  if (e.data?.type === "shutdown") {
    broadcast.close();
    self.close();
  }
};

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

      try {
        const memory = new Memory(msg.sessionId, 100, kvPrivatePath);
        const loop = new AgentLoop(
          msg.sessionId,
          config,
          msg.model ? { model: msg.model } : undefined,
          10,
          { memory },
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
