import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import { BrokerTransportRequestTracker } from "./transport_request_tracker.ts";
import { createBrokerRequestMessage } from "./transport_message_factory.ts";
import type {
  BrokerTransport,
  KvQueueTransportDeps,
} from "./transport_types.ts";
import type {
  BrokerMessage,
  BrokerRequestMessage,
  BrokerResponseMessage,
} from "./types.ts";
import { isBrokerResponseMessage } from "./types.ts";

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

  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    this.listening = true;

    const kv = await this.getKv();
    kv.listenQueue((raw: unknown) => {
      try {
        const msg = raw as BrokerMessage;
        if (msg.to !== this.agentId) {
          return;
        }
        if (!isBrokerResponseMessage(msg)) {
          log.debug(`Non-response message ignored: ${msg.type} (${msg.id})`);
          return;
        }

        if (!this.requestTracker.resolve(msg)) {
          log.debug(`Unexpected message: ${msg.type} (${msg.id})`);
        }
      } catch (error) {
        log.error(`KvQueueTransport: listenQueue callback error`, {
          error,
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
    const request = createBrokerRequestMessage(this.agentId, message);

    const response = this.requestTracker.create(
      request.id,
      timeoutMs,
      () =>
        new DenoClawError(
          "BROKER_TIMEOUT",
          { type: request.type, to: request.to, timeoutMs },
          "Broker did not respond in time. Check broker is running.",
        ),
    );

    try {
      await kv.enqueue(request);
    } catch (error) {
      const enqueueError = new DenoClawError(
        "BROKER_ENQUEUE_FAILED",
        { type: request.type, to: request.to, cause: String(error) },
        "KV enqueue failed. Check KV availability.",
      );
      this.requestTracker.reject(request.id, enqueueError);
      throw enqueueError;
    }

    log.debug(`Request sent to broker: ${request.type} (${request.id})`);
    return response;
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

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      this.kv = await Deno.openKv();
    }
    return this.kv;
  }
}
