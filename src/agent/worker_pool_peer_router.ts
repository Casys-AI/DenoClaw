import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";
import type { AgentRuntimeRegistry } from "./registry.ts";
import type {
  WorkerPeerResponseRequest,
  WorkerPeerResultMessage,
  WorkerPeerSendMessage,
  WorkerRequest,
} from "./worker_protocol.ts";

interface AgentMessagePending {
  fromAgent: string;
  sourceRequestId: string;
  taskId?: string;
  contextId?: string;
  traceId?: string;
  timer: number;
}

export interface WorkerPoolAgentHandle {
  worker: Pick<Worker, "postMessage">;
  agentId: string;
  ready: boolean;
}

export interface WorkerPoolPeerRouterDeps {
  runtimeRegistry: AgentRuntimeRegistry;
  getAgent(agentId: string): WorkerPoolAgentHandle | undefined;
  onAgentMessage?: (
    fromAgent: string,
    toAgent: string,
    message: string,
  ) => void;
  timeoutMs?: number;
}

const DEFAULT_AGENT_MESSAGE_TIMEOUT_MS = 120_000;

export class WorkerPoolPeerRouter {
  private agentPending = new Map<string, AgentMessagePending>();
  private timeoutMs: number;

  constructor(private readonly deps: WorkerPoolPeerRouterDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_AGENT_MESSAGE_TIMEOUT_MS;
  }

  routeAgentMessage(
    fromAgent: string,
    msg: WorkerPeerSendMessage,
  ): void {
    const registry = this.deps.runtimeRegistry.snapshot();
    if (Object.keys(registry).length > 0) {
      const sender = this.deps.runtimeRegistry.get(fromAgent);
      const target = this.deps.runtimeRegistry.get(msg.toAgent);
      const senderPeers = sender?.peers ?? [];
      if (!senderPeers.includes(msg.toAgent) && !senderPeers.includes("*")) {
        this.rejectAgentRequest(
          fromAgent,
          msg.requestId,
          "PEER_NOT_ALLOWED",
          `Agent "${fromAgent}" cannot send to "${msg.toAgent}" (not in peers)`,
        );
        return;
      }
      const targetAccept = target?.acceptFrom ?? [];
      if (!targetAccept.includes(fromAgent) && !targetAccept.includes("*")) {
        this.rejectAgentRequest(
          fromAgent,
          msg.requestId,
          "PEER_REJECTED",
          `Agent "${msg.toAgent}" does not accept from "${fromAgent}"`,
        );
        return;
      }
    }

    const targetEntry = this.deps.getAgent(msg.toAgent);
    if (!targetEntry || !targetEntry.ready) {
      this.rejectAgentRequest(
        fromAgent,
        msg.requestId,
        "NO_WORKER",
        `Agent "${msg.toAgent}" not found or not ready`,
      );
      return;
    }

    this.deps.onAgentMessage?.(fromAgent, msg.toAgent, msg.message);

    const deliverRequestId = generateId();
    const timer = setTimeout(() => {
      this.agentPending.delete(deliverRequestId);
      this.rejectAgentRequest(
        fromAgent,
        msg.requestId,
        "AGENT_MSG_TIMEOUT",
        `Agent "${msg.toAgent}" did not respond within 120s`,
      );
    }, this.timeoutMs);

    this.agentPending.set(deliverRequestId, {
      fromAgent,
      sourceRequestId: msg.requestId,
      taskId: msg.taskId,
      contextId: msg.contextId,
      traceId: msg.traceId,
      timer,
    });

    const deliverMsg: WorkerRequest = {
      type: "peer_deliver",
      requestId: deliverRequestId,
      fromAgent,
      message: msg.message,
      traceId: msg.traceId,
      taskId: msg.taskId,
      contextId: msg.contextId,
    };
    targetEntry.worker.postMessage(deliverMsg);

    log.info(`Agent message: ${fromAgent} → ${msg.toAgent}`);
  }

  handlePeerResult(msg: WorkerPeerResultMessage): void {
    const pendingReq = this.agentPending.get(msg.requestId);
    if (!pendingReq) return;

    clearTimeout(pendingReq.timer);
    this.agentPending.delete(msg.requestId);
    const source = this.deps.getAgent(pendingReq.fromAgent);
    if (!source) return;

    const response: WorkerPeerResponseRequest = {
      type: "peer_response",
      requestId: pendingReq.sourceRequestId,
      content: msg.content,
      error: msg.error,
    };
    source.worker.postMessage(response);
  }

  shutdown(): void {
    for (const pendingReq of this.agentPending.values()) {
      clearTimeout(pendingReq.timer);
    }
    this.agentPending.clear();
  }

  private rejectAgentRequest(
    fromAgent: string,
    sourceRequestId: string,
    code: string,
    message: string,
  ): void {
    const source = this.deps.getAgent(fromAgent);
    if (!source) return;

    const response: WorkerRequest = {
      type: "peer_response",
      requestId: sourceRequestId,
      content: `[${code}] ${message}`,
      error: true,
    };
    source.worker.postMessage(response);
  }
}
