import type { AgentEntry } from "../shared/types.ts";
import type {
  BrokerMessage,
  BrokerRequestMessage,
  BrokerResponseMessage,
} from "./types.ts";

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

export interface KvQueueTransportDeps {
  kv?: Deno.Kv;
}

export interface WebSocketBrokerTransportDeps {
  brokerUrl: string;
  authToken?: string;
  getAuthToken?: () => Promise<string>;
  endpoint?: string;
  config?: AgentEntry;
  onBrokerMessage?: (message: BrokerMessage) => void | Promise<void>;
}
