import type { SessionManager } from "../../messaging/session.ts";
import type { WorkerPool } from "../../agent/worker_pool.ts";
import { DenoClawError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

export const GATEWAY_WS_IDLE_TIMEOUT_SECONDS = 30;
const GATEWAY_WS_MAX_BUFFERED_AMOUNT = 1_000_000;

export interface GatewayWsChatPayload {
  type: "chat";
  message: string;
  agentId: string;
  sessionId?: string;
}

export function parseGatewayWsChatPayload(raw: string): GatewayWsChatPayload {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "payload", expected: "valid JSON string" },
      'Send a JSON payload like {"type":"chat","agentId":"...","message":"..."}',
    );
  }

  if (typeof data !== "object" || data === null) {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "payload", expected: "object" },
      "Send a JSON object payload",
    );
  }

  const record = data as Record<string, unknown>;
  if (record.type !== "chat") {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "type", expected: "chat" },
      'Only {"type":"chat", ...} messages are accepted on /ws',
    );
  }
  if (
    typeof record.agentId !== "string" || record.agentId.trim().length === 0
  ) {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "agentId" },
      "Provide a non-empty 'agentId' in the message",
    );
  }
  if (
    typeof record.message !== "string" || record.message.trim().length === 0
  ) {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "message" },
      "Provide a non-empty 'message' in the payload",
    );
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
    throw new DenoClawError(
      "INVALID_INPUT",
      { field: "sessionId" },
      "Provide 'sessionId' as a string when present",
    );
  }

  return {
    type: "chat",
    agentId: record.agentId,
    message: record.message,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

export function sendGatewayWsJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > GATEWAY_WS_MAX_BUFFERED_AMOUNT) {
    socket.close(1013, "Gateway WebSocket saturated");
    throw new DenoClawError(
      "WS_BACKPRESSURE",
      {
        bufferedAmount: socket.bufferedAmount,
        maxBufferedAmount: GATEWAY_WS_MAX_BUFFERED_AMOUNT,
      },
      "Reconnect after the WebSocket send buffer drains",
    );
  }
  socket.send(JSON.stringify(payload));
}

export interface GatewayWebSocketContext {
  session: SessionManager;
  workerPool: WorkerPool;
  wsClients: Map<string, WebSocket>;
}

export function handleGatewayWebSocketUpgrade(
  ctx: GatewayWebSocketContext,
  req: Request,
): Response {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token") || crypto.randomUUID();
  const { socket, response } = Deno.upgradeWebSocket(req, {
    idleTimeout: GATEWAY_WS_IDLE_TIMEOUT_SECONDS,
  });

  socket.onopen = () => {
    ctx.wsClients.set(token, socket);
    log.info(`WebSocket connected: ${token}`);
  };

  socket.onmessage = async (event) => {
    try {
      if (typeof event.data !== "string") {
        throw new DenoClawError(
          "INVALID_INPUT",
          { field: "payload", expected: "text frame" },
          "Binary WebSocket frames are not supported on /ws",
        );
      }

      const data = parseGatewayWsChatPayload(event.data);
      const sessionId = data.sessionId || `ws-${token}`;
      await ctx.session.getOrCreate(sessionId, token, "websocket");

      const result = await ctx.workerPool.send(
        data.agentId,
        sessionId,
        data.message,
      );
      sendGatewayWsJson(socket, {
        type: "response",
        sessionId,
        content: result.content,
      });
    } catch (err) {
      log.error("WebSocket message error", err);
      if (err instanceof DenoClawError) {
        sendGatewayWsJson(socket, {
          type: "error",
          error: err.toStructured(),
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendGatewayWsJson(socket, {
        type: "error",
        error: {
          code: "WS_MESSAGE_FAILED",
          context: { message },
          recovery: "Check message format",
        },
      });
    }
  };

  socket.onclose = () => {
    ctx.wsClients.delete(token);
    log.info(`WebSocket disconnected: ${token}`);
  };

  return response;
}
