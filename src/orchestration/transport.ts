import type {
  BrokerMessage,
  BrokerRequestMessage,
  BrokerResponseMessage,
} from "./types.ts";
import { isBrokerResponseMessage } from "./types.ts";
import { isAgentSocketRegisteredMessage } from "./agent_socket_protocol.ts";
import type { AgentEntry } from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";
import { BrokerTransportRequestTracker } from "./transport_request_tracker.ts";
import {
  type BrokerSocket,
  WebSocketBrokerConnectionRuntime,
} from "./transport_websocket_runtime.ts";

/**
 * Transport-agnostic send/receive interface for broker communication.
 *
 * Implementations hide the concrete transport (KV Queue, HTTP, SSE)
 * while BrokerClient operates in canonical task terms above this layer.
 */
export interface BrokerTransport {
  /** Start listening for responses from the broker. */
  start(): Promise<void>;

  /**
   * Send a message to the broker and receive the correlated response.
   * Implementations handle correlation, timeout, and error unwrapping.
   */
  send(
    message: Omit<BrokerRequestMessage, "id" | "from" | "timestamp">,
    timeoutMs?: number,
  ): Promise<BrokerResponseMessage>;

  /** Stop listening and reject any pending requests. */
  close(): void;
}

// ── KV Queue transport ──────────────────────────────────

export interface KvQueueTransportDeps {
  kv?: Deno.Kv;
}

/**
 * BrokerTransport backed by Deno KV Queues.
 *
 * Uses a pendingRequests Map to correlate outgoing enqueued messages
 * with incoming responses received via kv.listenQueue().
 * This is the local-mode transport — same Deno process, shared KV.
 */
export class KvQueueTransport implements BrokerTransport {
  private agentId: string;
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private requestTracker = new BrokerTransportRequestTracker<
    BrokerResponseMessage
  >();
  private listening = false;

  constructor(agentId: string, deps: KvQueueTransportDeps = {}) {
    this.agentId = agentId;
    this.kv = deps.kv ?? null;
    this.ownsKv = !deps.kv;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      this.kv = await Deno.openKv();
    }
    return this.kv;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;

    const kv = await this.getKv();
    kv.listenQueue((raw: unknown) => {
      try {
        const msg = raw as BrokerMessage;
        if (msg.to !== this.agentId) return;
        if (!isBrokerResponseMessage(msg)) {
          log.debug(`Non-response message ignored: ${msg.type} (${msg.id})`);
          return;
        }
        const response: BrokerResponseMessage = msg;

        if (!this.requestTracker.resolve(response)) {
          log.debug(`Unexpected message: ${response.type} (${response.id})`);
        }
      } catch (err) {
        log.error(`KvQueueTransport: listenQueue callback error`, {
          err,
        });
      }
    });

    log.info(`KvQueueTransport: listening started (agent: ${this.agentId})`);
  }

  async send(
    message: Omit<BrokerRequestMessage, "id" | "from" | "timestamp">,
    timeoutMs = 120_000,
  ): Promise<BrokerResponseMessage> {
    if (!this.listening) {
      throw new DenoClawError(
        "TRANSPORT_NOT_STARTED",
        {},
        "Call start() before send()",
      );
    }

    const kv = await this.getKv();
    const id = generateId();

    const msg = {
      ...message,
      id,
      from: this.agentId,
      timestamp: new Date().toISOString(),
    } as BrokerRequestMessage;

    const promise = this.requestTracker.create(
      id,
      timeoutMs,
      () =>
        new DenoClawError(
          "BROKER_TIMEOUT",
          { type: msg.type, to: msg.to, timeoutMs },
          "Broker did not respond in time. Check broker is running.",
        ),
    );

    try {
      await kv.enqueue(msg);
    } catch (err) {
      const error = new DenoClawError(
        "BROKER_ENQUEUE_FAILED",
        { type: msg.type, to: msg.to, cause: String(err) },
        "KV enqueue failed. Check KV availability.",
      );
      this.requestTracker.reject(id, error);
      throw error;
    }
    log.debug(`Request sent to broker: ${msg.type} (${id})`);

    return promise;
  }

  close(): void {
    this.requestTracker.rejectAll((requestId) =>
      new DenoClawError(
        "BROKER_CLOSED",
        { requestId },
        "BrokerClient was closed",
      )
    );
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
    this.listening = false;
  }
}

export interface WebSocketBrokerTransportDeps {
  brokerUrl: string;
  authToken?: string;
  getAuthToken?: () => Promise<string>;
  endpoint?: string;
  config?: AgentEntry;
  onBrokerMessage?: (message: BrokerMessage) => void | Promise<void>;
}
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

    const id = generateId();
    const msg = {
      ...message,
      id,
      from: this.agentId,
      timestamp: new Date().toISOString(),
    } as BrokerRequestMessage;

    const promise = this.requestTracker.create(
      id,
      timeoutMs,
      () =>
        new DenoClawError(
          "BROKER_TIMEOUT",
          { type: msg.type, to: msg.to, timeoutMs },
          "Broker did not respond in time. Check broker connectivity.",
        ),
    );

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      const error = new DenoClawError(
        "BROKER_SEND_FAILED",
        { type: msg.type, to: msg.to, cause: String(err) },
        "Check agent WebSocket connectivity to the broker",
      );
      this.requestTracker.reject(id, error);
      throw error;
    }

    return promise;
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
    if (this.ws?.readyState === WebSocket.OPEN) return;
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

    const msg = raw as BrokerMessage;
    if (isBrokerResponseMessage(msg)) {
      if (this.requestTracker.resolve(msg)) {
        return;
      }
    }

    if (this.onBrokerMessage) {
      await this.onBrokerMessage(msg);
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
