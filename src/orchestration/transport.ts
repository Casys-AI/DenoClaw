import type {
  BrokerMessage,
  BrokerRequestMessage,
  BrokerResponseMessage,
} from "./types.ts";
import { isBrokerResponseMessage } from "./types.ts";
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
