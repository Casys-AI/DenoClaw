import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import type {
  BrokerChannelIngressClient,
  ChannelIngressSubmission,
  ChannelRouteHint,
} from "./types.ts";

export interface InProcessBrokerChannelIngressClientDeps {
  submit(
    message: ChannelMessage,
    route?: ChannelRouteHint,
  ): Promise<ChannelIngressSubmission>;
  getTask(taskId: string): Promise<Task | null>;
  continueTask(
    taskId: string,
    message: ChannelMessage,
  ): Promise<Task | null>;
}

export class InProcessBrokerChannelIngressClient
  implements BrokerChannelIngressClient {
  constructor(private readonly deps: InProcessBrokerChannelIngressClientDeps) {}

  async start(): Promise<void> {
    await Promise.resolve();
  }

  async submit(
    message: ChannelMessage,
    route?: ChannelRouteHint,
  ): Promise<ChannelIngressSubmission> {
    return await this.deps.submit(message, route);
  }

  async getTask(taskId: string): Promise<Task | null> {
    return await this.deps.getTask(taskId);
  }

  async continueTask(
    taskId: string,
    message: ChannelMessage,
  ): Promise<Task | null> {
    return await this.deps.continueTask(taskId, message);
  }

  close(): void {
    // Stateless in-process client.
  }
}
