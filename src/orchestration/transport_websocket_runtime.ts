import {
  createAgentSocketRegisterMessage,
  DENOCLAW_AGENT_PROTOCOL,
} from "./agent_socket_protocol.ts";
import { log } from "../shared/log.ts";

const BROKER_WAKE_RETRIES = 3;
const BROKER_WAKE_DELAY_MS = 500;

export interface BrokerSocket {
  readyState: number;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(
    type: "open" | "error",
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: "open" | "error",
    listener: EventListenerOrEventListenerObject,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketBrokerConnectionRuntimeDeps {
  agentId: string;
  brokerUrl: string;
  endpoint?: string;
  resolveAuthToken(): Promise<string>;
  onSocketMessage(event: MessageEvent): void;
  onSocketClose(): void;
  createSocket?: (url: string, authToken: string) => BrokerSocket;
  wakeBroker?: () => Promise<void>;
  retries?: number;
  delayMs?: number;
}

export function resolveAgentSocketUrl(brokerUrl: string): string {
  const url = new URL("/agent/socket", brokerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function resolveAuthenticatedAgentSocketUrl(
  brokerUrlOrSocketUrl: string,
  authToken: string,
): string {
  const baseUrl = new URL(brokerUrlOrSocketUrl);
  const url = baseUrl.protocol === "ws:" || baseUrl.protocol === "wss:"
    ? baseUrl
    : new URL(resolveAgentSocketUrl(brokerUrlOrSocketUrl));
  url.searchParams.set("token", authToken);
  return url.toString();
}

function createAgentSocket(url: string, authToken: string): BrokerSocket {
  return new WebSocket(
    resolveAuthenticatedAgentSocketUrl(url, authToken),
    [DENOCLAW_AGENT_PROTOCOL],
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebSocketBrokerConnectionRuntime {
  private readonly createSocket: (
    url: string,
    authToken: string,
  ) => BrokerSocket;
  private readonly retries: number;
  private readonly delayMs: number;

  constructor(private readonly deps: WebSocketBrokerConnectionRuntimeDeps) {
    this.createSocket = deps.createSocket ?? createAgentSocket;
    this.retries = deps.retries ?? BROKER_WAKE_RETRIES;
    this.delayMs = deps.delayMs ?? BROKER_WAKE_DELAY_MS;
  }

  async connect(): Promise<BrokerSocket> {
    const socketUrl = resolveAgentSocketUrl(this.deps.brokerUrl);
    log.info(
      `WebSocketBrokerTransport: connecting ${this.deps.agentId} -> ${socketUrl}`,
    );
    const authToken = await this.deps.resolveAuthToken();

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      await this.wakeBroker();
      const socket = this.createSocket(socketUrl, authToken);
      this.bindSocket(socket);

      try {
        await this.waitForOpen(socket);
        socket.send(
          JSON.stringify(
            createAgentSocketRegisterMessage({
              agentId: this.deps.agentId,
              endpoint: this.deps.endpoint,
            }),
          ),
        );
        return socket;
      } catch (error) {
        lastError = error;
        try {
          socket.close(1013, "Retrying broker connection");
        } catch {
          // ignore close errors
        }
        if (attempt < this.retries) {
          await delay(this.delayMs);
        }
      }
    }

    throw lastError;
  }

  close(socket: BrokerSocket | null): void {
    if (!socket) return;
    try {
      socket.close(1000, "Transport closed");
    } catch {
      // ignore close errors
    }
  }

  private bindSocket(socket: BrokerSocket): void {
    socket.onmessage = (event) => {
      this.deps.onSocketMessage(event);
    };
    socket.onclose = () => {
      this.deps.onSocketClose();
    };
    socket.onerror = (event) => {
      log.error("WebSocketBrokerTransport: socket error", event);
    };
  }

  private waitForOpen(socket: BrokerSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onOpen: EventListener = () => {
        cleanup();
        resolve();
      };
      const onError: EventListener = (event) => {
        cleanup();
        reject(event);
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  }

  private async wakeBroker(): Promise<void> {
    if (this.deps.wakeBroker) {
      await this.deps.wakeBroker();
      return;
    }
    try {
      await fetch(new URL("/health", this.deps.brokerUrl));
    } catch (error) {
      log.warn("WebSocketBrokerTransport: broker wake-up failed", {
        agentId: this.deps.agentId,
        brokerUrl: this.deps.brokerUrl,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    await delay(this.delayMs);
  }
}
