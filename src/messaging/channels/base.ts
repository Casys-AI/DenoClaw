import type { ChannelMessage, OutboundChannelMessage } from "../types.ts";
import { log } from "../../shared/log.ts";

export type OnMessage = (message: ChannelMessage) => void | Promise<void>;

export interface ChannelAdapter {
  readonly channelType: string;
  enabled: boolean;
  initialize(): Promise<void>;
  start(onMessage: OnMessage): Promise<void> | void;
  stop(): Promise<void>;
  send(message: OutboundChannelMessage): Promise<void>;
  isConnected(): boolean;
  getStatus(): { type: string; enabled: boolean; connected: boolean };
}

/**
 * Abstract channel — simplified vs nano-claw: no EventEmitter,
 * uses a callback pattern instead.
 */
export abstract class BaseChannel implements ChannelAdapter {
  readonly channelType: string;
  enabled: boolean;
  protected onMessage?: OnMessage;

  constructor(channelType: string) {
    this.channelType = channelType;
    this.enabled = false;
  }

  abstract initialize(): Promise<void>;
  abstract start(onMessage: OnMessage): Promise<void> | void;
  abstract stop(): Promise<void>;
  abstract send(message: OutboundChannelMessage): Promise<void>;
  abstract isConnected(): boolean;

  getStatus(): { type: string; enabled: boolean; connected: boolean } {
    return {
      type: this.channelType,
      enabled: this.enabled,
      connected: this.isConnected(),
    };
  }

  protected isAuthorized(userId: string, allowFrom?: string[]): boolean {
    if (!allowFrom?.length) return true;
    const ok = allowFrom.includes(userId);
    if (!ok) {
      log.warn(`Unauthorized user: ${userId} on ${this.channelType}`);
    }
    return ok;
  }
}
