import type { AgentEntry } from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import { isAgentSocketRegisteredMessage } from "./agent_socket_protocol.ts";
import { createBrokerRequestMessage } from "./transport_message_factory.ts";
import { BrokerTransportRequestTracker } from "./transport_request_tracker.ts";
import {
  type BrokerSocket,
  WebSocketBrokerConnectionRuntime,
} from "./transport_websocket_runtime.ts";
import type {
  BrokerTransport,
  WebSocketBrokerTransportDeps,
} from "./transport_types.ts";
import type {
  BrokerMessage,
  BrokerRequestMessage,
  BrokerResponseMessage,
} from "./types.ts";
import { isBrokerResponseMessage } from "./types.ts";

export {
  resolveAgentSocketUrl,
  resolveAuthenticatedAgentSocketUrl,
} from "./transport_websocket_runtime.ts";

export class WebSocketBrokerTransport implements BrokerTransport {
  private agentId: string;
  private brokerUrl: string;
  private authToken?: string;
  private getAuthToken?: () => Promise<string>;
  private endpoint?: string;
  private config?: AgentEntry;
  private onBrokerMessage?: (message: BrokerMessage) => void | Promise<void>;
  private ws: BrokerSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private requestTracker = new BrokerTransportRequestTracker<
    BrokerResponseMessage
  >();
  private connectionRuntime: WebSocketBrokerConnectionRuntime;

  constructor(agentId: string, deps: WebSocketBrokerTransportDeps) {
    this.agentId = agentId;
    this.brokerUrl = deps.brokerUrl;
    this.authToken = deps.authToken;
    this.getAuthToken = deps.getAuthToken;
    this.endpoint = deps.endpoint;
    this.config = deps.config;
    this.onBrokerMessage = deps.onBrokerMessage;

    if (!this.authToken && !this.getAuthToken) {
      throw new DenoClawError(
        "BROKER_AUTH_MISSING",
        { agentId, brokerUrl: deps.brokerUrl },
        "Provide authToken or getAuthToken for WebSocket broker transport",
      );
    }

    this.connectionRuntime = new WebSocketBrokerConnectionRuntime({
      agentId: this.agentId,
      brokerUrl: this.brokerUrl,
      endpoint: this.endpoint,
      config: this.config,
      resolveAuthToken: () => this.resolveAuthToken(),
      onSocketMessage: (event) => {
        void this.handleSocketMessage(event);
      },
      onSocketClose: () => {
        this.ws = null;
        this.requestTracker.rejectAll((requestId) =>
          new DenoClawError(
            "BROKER_CLOSED",
            { requestId, agentId: this.agentId },
            "Broker WebSocket disconnected",
          )
        );
      },
    });
  }

  async start(): Promise<void> {
    await this.ensureConnected();
  }

  async send(
    message: Omit<BrokerRequestMessage, "id" | "from" | "timestamp">,
    timeoutMs = 120_000,
  ): Promise<BrokerResponseMessage> {
    await this.ensureConnected();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new DenoClawError(
        "TRANSPORT_NOT_STARTED",
        {},
        "Broker WebSocket is not connected",
      );
    }

    const request = createBrokerRequestMessage(this.agentId, message);
    const response = this.requestTracker.create(
      request.id,
      timeoutMs,
      () =>
        new DenoClawError(
          "BROKER_TIMEOUT",
          { type: request.type, to: request.to, timeoutMs },
          "Broker did not respond in time. Check broker connectivity.",
        ),
    );

    try {
      ws.send(JSON.stringify(request));
    } catch (error) {
      const sendError = new DenoClawError(
        "BROKER_SEND_FAILED",
        { type: request.type, to: request.to, cause: String(error) },
        "Check agent WebSocket connectivity to the broker",
      );
      this.requestTracker.reject(request.id, sendError);
      throw sendError;
    }

    return response;
  }

  close(): void {
    this.requestTracker.rejectAll((requestId) =>
      new DenoClawError(
        "BROKER_CLOSED",
        { requestId },
        "Broker transport was closed",
      )
    );
    this.connectPromise = null;
    this.connectionRuntime.close(this.ws);
    this.ws = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    this.ws = await this.connectionRuntime.connect();
  }

  private async handleSocketMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== "string") {
      log.warn("WebSocketBrokerTransport: non-text frame ignored");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      log.warn("WebSocketBrokerTransport: invalid JSON frame ignored");
      return;
    }

    if (isAgentSocketRegisteredMessage(raw)) {
      log.info(`WebSocketBrokerTransport: registered as ${raw.agentId}`);
      return;
    }

    const message = raw as BrokerMessage;
    if (
      isBrokerResponseMessage(message) && this.requestTracker.resolve(message)
    ) {
      return;
    }

    if (this.onBrokerMessage) {
      await this.onBrokerMessage(message);
    }
  }

  private async resolveAuthToken(): Promise<string> {
    if (this.getAuthToken) {
      return await this.getAuthToken();
    }
    if (this.authToken) {
      return this.authToken;
    }
    throw new DenoClawError(
      "BROKER_AUTH_MISSING",
      { agentId: this.agentId, brokerUrl: this.brokerUrl },
      "No broker auth token available for WebSocket transport",
    );
  }
}
