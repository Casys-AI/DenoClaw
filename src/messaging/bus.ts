import type { ChannelMessage } from "./types.ts";
import { log } from "../shared/log.ts";
import { DenoClawError } from "../shared/errors.ts";
import { spanBusPublish } from "../telemetry/mod.ts";

export type MessageHandler = (message: ChannelMessage) => Promise<void>;

/**
 * MessageBus for channel message delivery (Telegram, webhooks, etc.).
 *
 * Uses KV Queues as an optional optimization for durable at-least-once delivery.
 * Falls back to direct in-memory dispatch if KV is unavailable.
 * This bus handles channel routing only — broker↔agent task transport
 * is handled separately by BrokerTransport.
 */
export class MessageBus {
  private handlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private kvReady = false;

  constructor(kv?: Deno.Kv) {
    if (kv) {
      this.kv = kv;
      this.kvReady = true;
    }
    this.ownsKv = !kv;
  }

  async init(): Promise<void> {
    if (this.kvReady && this.kv) {
      // KV déjà injecté via constructeur — just start listening
      this.kv.listenQueue(async (raw: unknown) => {
        const message = raw as ChannelMessage;
        log.debug(`KV Queue: message reçu (${message.id})`);
        await this.dispatch(message);
      });
      log.info("MessageBus: KV Queues activées (injecté)");
      return;
    }

    this.kv = await Deno.openKv();
    this.kv.listenQueue(async (raw: unknown) => {
      const message = raw as ChannelMessage;
      log.debug(`KV Queue: message reçu (${message.id})`);
      await this.dispatch(message);
    });
    this.kvReady = true;
    log.info("MessageBus: KV Queues activées");
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
   * Publish a message via KV Queue.
   * Requires init() to have been called successfully.
   */
  async publish(message: ChannelMessage): Promise<void> {
    await spanBusPublish(message.channelType, message.id, async () => {
      if (!this.kvReady || !this.kv) {
        throw new DenoClawError(
          "BUS_NOT_INITIALIZED",
          {},
          "Call bus.init() before publishing messages",
        );
      }
      log.info(`Bus: message de ${message.channelType} (${message.id})`);
      await this.kv.enqueue(message);
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

  private async safeCall(
    handler: MessageHandler,
    message: ChannelMessage,
  ): Promise<void> {
    try {
      await handler(message);
    } catch (e) {
      log.error(`Bus handler error (channel: ${message.channelType}, msg: ${message.id})`, e);
    }
  }

  clear(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }

  close(): void {
    this.clear();
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
    this.kvReady = false;
  }
}
