import type { WorkerRequest } from "./worker_protocol.ts";

export interface WorkerPoolWorker {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: "message",
    listener: EventListenerOrEventListenerObject,
  ): void;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface AgentWorker {
  worker: WorkerPoolWorker;
  agentId: string;
  ready: boolean;
}

export interface WorkerPoolCallbacks {
  onWorkerReady?: (agentId: string) => void;
  onWorkerStopped?: (agentId: string) => void;
  onAgentMessage?: (
    fromAgent: string,
    toAgent: string,
    message: string,
  ) => void;
}
