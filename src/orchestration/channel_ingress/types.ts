import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";

export interface DirectChannelIngressRouteInput {
  agentId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface DirectChannelIngressRoute {
  agentId: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Legacy compatibility alias for the current direct-only ingress seam.
 * Prefer `DirectChannelIngressRoute` in new code.
 */
export type ChannelRouteHint = DirectChannelIngressRoute;

export interface ChannelIngressSubmission {
  task: Task;
  taskId: string;
  contextId?: string;
}

export interface BrokerChannelIngressClient {
  start(): Promise<void>;
  /**
   * Accepts an ingress route plan at the seam boundary.
   * Current runtimes may still reject non-direct delivery explicitly until
   * shared ingress execution is implemented.
   */
  submit(
    message: ChannelMessage,
    route?: ChannelRoutePlan,
  ): Promise<ChannelIngressSubmission>;
  getTask(taskId: string): Promise<Task | null>;
  continueTask(
    taskId: string,
    message: ChannelMessage,
  ): Promise<Task | null>;
  close(): void;
}
