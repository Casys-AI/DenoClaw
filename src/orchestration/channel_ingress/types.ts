import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";

export interface ChannelRouteHint {
  agentId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelIngressSubmission {
  task: Task;
  taskId: string;
  contextId?: string;
}

export interface BrokerChannelIngressClient {
  start(): Promise<void>;
  submit(
    message: ChannelMessage,
    route?: ChannelRouteHint,
  ): Promise<ChannelIngressSubmission>;
  getTask(taskId: string): Promise<Task | null>;
  continueTask(
    taskId: string,
    message: ChannelMessage,
  ): Promise<Task | null>;
  close(): void;
}
