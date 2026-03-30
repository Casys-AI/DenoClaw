import type {
  BrokerMessage,
  BrokerRequestMessage,
  BrokerResponseMessage,
} from "./types.ts";
import { isBrokerResponseMessage } from "./types.ts";
import {
  createAgentSocketRegisterMessage,
  DENOCLAW_AGENT_PROTOCOL,
  isAgentSocketRegisteredMessage,
} from "./agent_socket_protocol.ts";
import type { AgentEntry } from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";

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

type DenoWebSocketWithHeaders = {
  new (
    url: string,
    options: {
      headers: Record<string, string>;
      protocols: string[];
    },
  ): WebSocket;
};

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
  private pendingRequests = new Map<string, {
    resolve: (value: BrokerResponseMessage) => void;
    reject: (reason: unknown) => void;
  }>();
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

        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          pending.resolve(response);
        } else {
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

    const promise = new Promise<BrokerResponseMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(
            new DenoClawError(
              "BROKER_TIMEOUT",
              { type: msg.type, to: msg.to, timeoutMs },
              "Broker did not respond in time. Check broker is running.",
            ),
          );
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeoutId);
          reject(reason);
        },
      });
    });

    try {
      await kv.enqueue(msg);
    } catch (err) {
      this.pendingRequests.delete(id);
      const error = new DenoClawError(
        "BROKER_ENQUEUE_FAILED",
        { type: msg.type, to: msg.to, cause: String(err) },
        "KV enqueue failed. Check KV availability.",
      );
      throw error;
    }
    log.debug(`Request sent to broker: ${msg.type} (${id})`);

    return promise;
  }

  close(): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(
        new DenoClawError(
          "BROKER_CLOSED",
          { requestId: id },
          "BrokerClient was closed",
        ),
      );
    }
    this.pendingRequests.clear();
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
    this.listening = false;
  }
}

// ── WebSocket transport (deploy mode) ──────────────────

export interface WebSocketBrokerTransportDeps {
  brokerUrl: string;
  authToken?: string;
  getAuthToken?: () => Promise<string>;
  endpoint?: string;
  config?: AgentEntry;
  onBrokerMessage?: (message: BrokerMessage) => void | Promise<void>;
}

export function resolveAgentSocketUrl(brokerUrl: string): string {
  const url = new URL("/agent/socket", brokerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createAgentSocket(
  url: string,
  authToken: string,
): WebSocket {
  const DenoWebSocket = WebSocket as unknown as DenoWebSocketWithHeaders;
  return new DenoWebSocket(url, {
    headers: {
      authorization: `Bearer ${authToken}`,
    },
    protocols: [DENOCLAW_AGENT_PROTOCOL],
  });
}

export class WebSocketBrokerTransport implements BrokerTransport {
  private agentId: string;
  private brokerUrl: string;
  private authToken?: string;
  private getAuthToken?: () => Promise<string>;
  private endpoint?: string;
  private config?: AgentEntry;
  private onBrokerMessage?: (message: BrokerMessage) => void | Promise<void>;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: BrokerResponseMessage) => void;
    reject: (reason: unknown) => void;
  }>();

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

    const promise = new Promise<BrokerResponseMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(
            new DenoClawError(
              "BROKER_TIMEOUT",
              { type: msg.type, to: msg.to, timeoutMs },
              "Broker did not respond in time. Check broker connectivity.",
            ),
          );
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeoutId);
          reject(reason);
        },
      });
    });

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.pendingRequests.delete(id);
      throw new DenoClawError(
        "BROKER_SEND_FAILED",
        { type: msg.type, to: msg.to, cause: String(err) },
        "Check agent WebSocket connectivity to the broker",
      );
    }

    return promise;
  }

  close(): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(
        new DenoClawError(
          "BROKER_CLOSED",
          { requestId: id },
          "Broker transport was closed",
        ),
      );
    }
    this.pendingRequests.clear();
    this.connectPromise = null;
    if (this.ws) {
      try {
        this.ws.close(1000, "Transport closed");
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
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
    const socketUrl = resolveAgentSocketUrl(this.brokerUrl);
    log.info(
      `WebSocketBrokerTransport: connecting ${this.agentId} -> ${socketUrl}`,
    );

    const ws = createAgentSocket(socketUrl, await this.resolveAuthToken());
    this.ws = ws;

    ws.onmessage = (event) => {
      void this.handleSocketMessage(event);
    };

    ws.onclose = () => {
      this.ws = null;
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(
          new DenoClawError(
            "BROKER_CLOSED",
            { requestId: id, agentId: this.agentId },
            "Broker WebSocket disconnected",
          ),
        );
      }
      this.pendingRequests.clear();
    };

    ws.onerror = (event) => {
      log.error("WebSocketBrokerTransport: socket error", event);
    };

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        ws.send(
          JSON.stringify(
            createAgentSocketRegisterMessage({
              agentId: this.agentId,
              endpoint: this.endpoint,
              config: this.config,
            }),
          ),
        );
        resolve();
      };
      const onError = (event: Event) => {
        cleanup();
        reject(event);
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
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
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg);
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
