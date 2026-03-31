import type { Task } from "../../messaging/a2a/types.ts";
import type { ChannelMessage } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";
import type {
  BrokerChannelIngressClient,
  ChannelIngressSubmission,
} from "./types.ts";

export interface HttpBrokerChannelIngressClientDeps {
  brokerUrl: string;
  authToken?: string;
  getAuthToken?: () => Promise<string>;
  fetchFn?: typeof fetch;
}

interface ChannelIngressResponseBody {
  task?: Task | null;
  error?: {
    code?: string;
    context?: Record<string, unknown>;
    recovery?: string;
  };
}

export class HttpBrokerChannelIngressClient
  implements BrokerChannelIngressClient {
  private readonly brokerUrl: string;
  private readonly authToken?: string;
  private readonly getAuthToken?: () => Promise<string>;
  private readonly fetchFn: typeof fetch;

  constructor(deps: HttpBrokerChannelIngressClientDeps) {
    this.brokerUrl = deps.brokerUrl;
    this.authToken = deps.authToken;
    this.getAuthToken = deps.getAuthToken;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async start(): Promise<void> {
    await Promise.resolve();
  }

  async submit(
    message: ChannelMessage,
    route?: ChannelRoutePlan,
  ): Promise<ChannelIngressSubmission> {
    const response = await this.request("/ingress/messages", {
      method: "POST",
      body: JSON.stringify({ message, route }),
    });
    const task = this.requireTask(response, {
      route,
      messageId: message.id,
    });
    return {
      task,
      taskId: task.id,
      contextId: task.contextId,
    };
  }

  async getTask(taskId: string): Promise<Task | null> {
    const response = await this.request(`/ingress/tasks/${taskId}`);
    return response.task ?? null;
  }

  async continueTask(
    taskId: string,
    message: ChannelMessage,
  ): Promise<Task | null> {
    const response = await this.request(`/ingress/tasks/${taskId}/continue`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return response.task ?? null;
  }

  close(): void {
    // Stateless HTTP client.
  }

  private async request(
    path: string,
    init?: RequestInit,
  ): Promise<ChannelIngressResponseBody> {
    const authToken = await this.resolveAuthToken();
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    if (authToken) {
      headers.set("authorization", `Bearer ${authToken}`);
    }

    const response = await this.fetchFn(new URL(path, this.brokerUrl), {
      ...init,
      headers,
    });
    const body =
      (await response.json().catch(() => ({}))) as ChannelIngressResponseBody;

    if (!response.ok) {
      throw new DenoClawError(
        body.error?.code || "BROKER_CHANNEL_INGRESS_FAILED",
        body.error?.context ?? {
          path,
          status: response.status,
        },
        body.error?.recovery || "Check broker channel ingress availability",
      );
    }

    return body;
  }

  private requireTask(
    response: ChannelIngressResponseBody,
    context: Record<string, unknown>,
  ): Task {
    if (response.task) return response.task;
    throw new DenoClawError(
      "TASK_NOT_FOUND",
      context,
      "Broker channel ingress did not return a persisted task",
    );
  }

  private async resolveAuthToken(): Promise<string | undefined> {
    if (this.getAuthToken) return await this.getAuthToken();
    return this.authToken;
  }
}
