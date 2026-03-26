import type { ChannelMessage } from "../types.ts";
import { log } from "../utils/log.ts";
import { spanBusPublish } from "../telemetry/mod.ts";

export type MessageHandler = (message: ChannelMessage) => Promise<void>;

/**
 * MessageBus backed by Deno KV Queues.
 *
 * - publish() → kv.enqueue() for durable, at-least-once delivery
 * - Handlers are registered in-memory but triggered by kv.listenQueue()
 * - Falls back to direct in-memory dispatch if KV is unavailable
 */
export class MessageBus {
  private handlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();
  private kv: Deno.Kv | null = null;
  private kvReady = false;

  async init(): Promise<void> {
    try {
      this.kv = await Deno.openKv();

      // Listen for queued messages — this is the consumer side
      this.kv.listenQueue(async (raw: unknown) => {
        const message = raw as ChannelMessage;
        log.debug(`KV Queue: message reçu (${message.id})`);
        await this.dispatch(message);
      });

      this.kvReady = true;
      log.info("MessageBus: KV Queues activées");
    } catch (e) {
      log.warn("MessageBus: KV indisponible, fallback in-memory", e);
      this.kvReady = false;
    }
  }

  subscribe(channelType: string, handler: MessageHandler): void {
    if (!this.handlers.has(channelType)) {
      this.handlers.set(channelType, new Set());
    }
    this.handlers.get(channelType)!.add(handler);
  }

  subscribeAll(handler: MessageHandler): void {
    this.globalHandlers.add(handler);
  }

  unsubscribe(channelType: string, handler: MessageHandler): void {
    this.handlers.get(channelType)?.delete(handler);
  }

  unsubscribeAll(handler: MessageHandler): void {
    this.globalHandlers.delete(handler);
  }

  /**
   * Publish a message.
   * If KV is available → kv.enqueue() for durable delivery.
   * Otherwise → direct in-memory dispatch.
   */
  async publish(message: ChannelMessage): Promise<void> {
    await spanBusPublish(message.channelType, message.id, async () => {
      log.info(`Bus: message de ${message.channelType} (${message.id})`);

      if (this.kvReady && this.kv) {
        await this.kv.enqueue(message);
      } else {
        await this.dispatch(message);
      }
    });
  }

  /**
   * Dispatch to registered handlers (called by listenQueue or directly).
   */
  private async dispatch(message: ChannelMessage): Promise<void> {
    const channelHandlers = this.handlers.get(message.channelType);
    const promises: Promise<void>[] = [];

    if (channelHandlers) {
      for (const h of channelHandlers) {
        promises.push(this.safeCall(h, message));
      }
    }
    for (const h of this.globalHandlers) {
      promises.push(this.safeCall(h, message));
    }

    await Promise.all(promises);
  }

  private async safeCall(handler: MessageHandler, message: ChannelMessage): Promise<void> {
    try {
      await handler(message);
    } catch (e) {
      log.error("Erreur handler message bus", e);
    }
  }

  clear(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }

  close(): void {
    this.clear();
    if (this.kv) {
      this.kv.close();
      this.kv = null;
      this.kvReady = false;
    }
  }
}

let _bus: MessageBus | null = null;
export function getMessageBus(): MessageBus {
  if (!_bus) _bus = new MessageBus();
  return _bus;
}
