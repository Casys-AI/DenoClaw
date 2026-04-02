import type {
  A2AMessage,
  A2AMethod,
  AgentCard,
  Artifact,
  JsonRpcRequest,
  JsonRpcResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "./types.ts";
import { A2A_ERRORS } from "./types.ts";
import { TaskStore } from "./tasks.ts";
import { log } from "../../shared/log.ts";

type TaskHandler = (task: Task, message: A2AMessage) => Promise<void>;
type A2AServerDeps = {
  store?: TaskStore;
};

/**
 * A2A Server — expose a DenoClaw agent as an A2A-compatible endpoint.
 *
 * Handles JSON-RPC 2.0 over HTTP + SSE streaming.
 * Serves AgentCard at /.well-known/agent-card.json.
 */
export class A2AServer {
  private card: AgentCard;
  private store: TaskStore;
  private handler: TaskHandler;
  private activeStreams = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >();

  constructor(card: AgentCard, handler: TaskHandler, deps: A2AServerDeps = {}) {
    this.card = card;
    this.store = deps.store ?? new TaskStore();
    this.handler = handler;
  }

  /**
   * Handle an HTTP request (plug into Deno.serve or gateway).
   */
  async handleRequest(req: Request, basePath = ""): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;

    // AgentCard discovery
    if (
      path === "/.well-known/agent-card.json" ||
      path === `${basePath}/.well-known/agent-card.json`
    ) {
      return Response.json(this.card);
    }

    // JSON-RPC endpoint
    if (path === this.getEndpointPath(basePath) && req.method === "POST") {
      return await this.handleRpc(req);
    }

    return null; // not handled
  }

  private getEndpointPath(basePath: string): string {
    // Extract path from card URL
    try {
      const cardPath = new URL(this.card.url).pathname;
      return cardPath;
    } catch {
      return `${basePath}/a2a`;
    }
  }

  private async handleRpc(req: Request): Promise<Response> {
    let rpc: JsonRpcRequest;
    try {
      rpc = await req.json() as JsonRpcRequest;
    } catch {
      return Response.json(this.rpcError(null, -32700, "Parse error"));
    }

    if (rpc.jsonrpc !== "2.0" || !rpc.method) {
      return Response.json(this.rpcError(rpc.id, -32600, "Invalid Request"));
    }

    log.debug(`A2A RPC: ${rpc.method} (${rpc.id})`);

    switch (rpc.method as A2AMethod) {
      case "message/send":
        return await this.handleSend(rpc);
      case "message/stream":
        return await this.handleStream(rpc);
      case "tasks/get":
        return await this.handleGetTask(rpc);
      case "tasks/cancel":
        return await this.handleCancel(rpc);
      default:
        return Response.json(
          this.rpcError(
            rpc.id,
            A2A_ERRORS.UNSUPPORTED_OPERATION,
            `Unknown method: ${rpc.method}`,
          ),
        );
    }
  }

  // ── message/send ───────────────────────────────────

  private async handleSend(rpc: JsonRpcRequest): Promise<Response> {
    const params = rpc.params as { message: A2AMessage; taskId?: string };
    if (!params?.message) {
      return Response.json(
        this.rpcError(rpc.id, -32602, "Missing message param"),
      );
    }

    let task: Task;

    if (params.taskId) {
      // Continue existing task
      const existing = await this.store.get(params.taskId);
      if (!existing) {
        return Response.json(
          this.rpcError(rpc.id, A2A_ERRORS.TASK_NOT_FOUND, "Task not found"),
        );
      }
      if (!this.store.canAcceptUpdates(existing)) {
        return Response.json(
          this.rpcError(
            rpc.id,
            A2A_ERRORS.TASK_NOT_CANCELABLE,
            "Task in terminal state",
          ),
        );
      }
      await this.store.appendHistoryMessage(params.taskId, params.message);
      task = existing;
    } else {
      // New task
      const taskId = crypto.randomUUID();
      task = await this.store.create(taskId, params.message);
    }

    // Execute
    await this.store.startWorking(task.id);

    try {
      await this.handler(task, params.message);
      const updated = await this.store.get(task.id);
      return Response.json(this.rpcSuccess(rpc.id, updated));
    } catch (e) {
      await this.store.failTask(task.id, {
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: (e as Error).message }],
      });
      const failed = await this.store.get(task.id);
      return Response.json(this.rpcSuccess(rpc.id, failed));
    }
  }

  // ── message/stream ─────────────────────────────────

  private async handleStream(rpc: JsonRpcRequest): Promise<Response> {
    const params = rpc.params as { message: A2AMessage; taskId?: string };
    if (!params?.message) {
      return Response.json(
        this.rpcError(rpc.id, -32602, "Missing message param"),
      );
    }

    const taskId = params.taskId || crypto.randomUUID();
    let task: Task;

    if (params.taskId) {
      const existing = await this.store.get(params.taskId);
      if (!existing) {
        return Response.json(
          this.rpcError(rpc.id, A2A_ERRORS.TASK_NOT_FOUND, "Task not found"),
        );
      }
      if (!this.store.canAcceptUpdates(existing)) {
        return Response.json(
          this.rpcError(
            rpc.id,
            A2A_ERRORS.TASK_NOT_CANCELABLE,
            "Task in terminal state",
          ),
        );
      }
      await this.store.appendHistoryMessage(params.taskId, params.message);
      task = existing;
    } else {
      task = await this.store.create(taskId, params.message);
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        this.activeStreams.set(taskId, controller);

        // Send initial task status (spec-compliant: taskStatusUpdate for SUBMITTED state)
        this.sseEvent(controller, encoder, rpc.id, {
          kind: "taskStatusUpdate",
          taskId: task.id,
          status: task.status,
          final: false,
        } as TaskStatusUpdateEvent);

        // Working
        const workingTask = await this.store.startWorking(task.id);
        this.sseEvent(controller, encoder, rpc.id, {
          kind: "taskStatusUpdate",
          taskId: task.id,
          status: workingTask?.status ?? {
            state: "WORKING",
            timestamp: new Date().toISOString(),
          },
          final: false,
        } as TaskStatusUpdateEvent);

        // Execute
        try {
          await this.handler(task, params.message);
          const completed = await this.store.get(task.id);

          // Send artifacts
          if (completed?.artifacts) {
            for (const artifact of completed.artifacts) {
              this.sseEvent(controller, encoder, rpc.id, {
                kind: "artifactUpdate",
                taskId: task.id,
                artifact,
              } as TaskArtifactUpdateEvent);
            }
          }

          // Final status
          this.sseEvent(controller, encoder, rpc.id, {
            kind: "taskStatusUpdate",
            taskId: task.id,
            status: completed?.status ||
              { state: "COMPLETED", timestamp: new Date().toISOString() },
            final: true,
          } as TaskStatusUpdateEvent);
        } catch (e) {
          const failed = await this.store.failTask(task.id, {
            messageId: crypto.randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: (e as Error).message }],
          });
          this.sseEvent(
            controller,
            encoder,
            rpc.id,
            {
              kind: "taskStatusUpdate",
              taskId: task.id,
              status: failed?.status ?? {
                state: "FAILED",
                timestamp: new Date().toISOString(),
              },
              final: true,
            } as TaskStatusUpdateEvent & { error: string },
          );
          log.error(`A2A stream error: ${(e as Error).message}`);
        }

        this.activeStreams.delete(taskId);
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // ── tasks/get ──────────────────────────────────────

  private async handleGetTask(rpc: JsonRpcRequest): Promise<Response> {
    const taskId = (rpc.params as { taskId: string })?.taskId;
    if (!taskId) {
      return Response.json(this.rpcError(rpc.id, -32602, "Missing taskId"));
    }

    const task = await this.store.get(taskId);
    if (!task) {
      return Response.json(
        this.rpcError(rpc.id, A2A_ERRORS.TASK_NOT_FOUND, "Task not found"),
      );
    }

    return Response.json(this.rpcSuccess(rpc.id, task));
  }

  // ── tasks/cancel ───────────────────────────────────

  private async handleCancel(rpc: JsonRpcRequest): Promise<Response> {
    const taskId = (rpc.params as { taskId: string })?.taskId;
    if (!taskId) {
      return Response.json(this.rpcError(rpc.id, -32602, "Missing taskId"));
    }

    const task = await this.store.get(taskId);
    if (!task) {
      return Response.json(
        this.rpcError(rpc.id, A2A_ERRORS.TASK_NOT_FOUND, "Task not found"),
      );
    }
    if (!this.store.canAcceptUpdates(task)) {
      return Response.json(
        this.rpcError(
          rpc.id,
          A2A_ERRORS.TASK_NOT_CANCELABLE,
          "Task in terminal state",
        ),
      );
    }

    const canceled = await this.store.cancel(taskId);
    return Response.json(this.rpcSuccess(rpc.id, canceled));
  }

  // ── Helpers ────────────────────────────────────────

  /**
   * Complete a task with an artifact (call from handler).
   */
  async completeTask(taskId: string, text: string): Promise<void> {
    const artifact: Artifact = {
      artifactId: crypto.randomUUID(),
      parts: [{ kind: "text", text }],
    };
    await this.store.addArtifact(taskId, artifact);
    await this.store.completeTask(taskId, {
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ kind: "text", text }],
    });
  }

  /**
   * Fail a task with a message (call from handler).
   */
  async failTask(taskId: string, error: string): Promise<void> {
    await this.store.failTask(taskId, {
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ kind: "text", text: error }],
    });
  }

  private sseEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    rpcId: string,
    result: unknown,
  ): void {
    const response: JsonRpcResponse = { jsonrpc: "2.0", id: rpcId, result };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
  }

  private rpcSuccess(id: string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id || "", result };
  }

  private rpcError(
    id: string | null,
    code: number,
    message: string,
  ): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id || "", error: { code, message } };
  }

  getTaskStore(): TaskStore {
    return this.store;
  }

  close(): void {
    this.store.close();
  }
}
