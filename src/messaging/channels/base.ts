import type { ChannelMessage, OutboundChannelMessage } from "../types.ts";
import { log } from "../../shared/log.ts";

export type OnMessage = (message: ChannelMessage) => void | Promise<void>;

export interface ChannelAdapter {
  readonly channelType: string;
  readonly adapterId: string;
  readonly accountId?: string;
  enabled: boolean;
  initialize(): Promise<void>;
  start(onMessage: OnMessage): Promise<void> | void;
  stop(): Promise<void>;
  send(message: OutboundChannelMessage): Promise<void>;
  isConnected(): boolean;
  getStatus(): {
    type: string;
    adapterId: string;
    accountId?: string;
    enabled: boolean;
    connected: boolean;
  };
}

/**
 * Abstract channel — simplified vs nano-claw: no EventEmitter,
 * uses a callback pattern instead.
 */
export abstract class BaseChannel implements ChannelAdapter {
  readonly channelType: string;
  readonly adapterId: string;
  enabled: boolean;
  protected onMessage?: OnMessage;
  protected routingAccountId?: string;

  constructor(
    channelType: string,
    options: { adapterId?: string; accountId?: string } = {},
  ) {
    this.channelType = channelType;
    this.adapterId = options.adapterId ?? channelType;
    this.routingAccountId = options.accountId;
    this.enabled = false;
  }

  abstract initialize(): Promise<void>;
  abstract start(onMessage: OnMessage): Promise<void> | void;
  abstract stop(): Promise<void>;
  abstract send(message: OutboundChannelMessage): Promise<void>;
  abstract isConnected(): boolean;

  get accountId(): string | undefined {
    return this.routingAccountId;
  }

  getStatus(): {
    type: string;
    adapterId: string;
    accountId?: string;
    enabled: boolean;
    connected: boolean;
  } {
    return {
      type: this.channelType,
      adapterId: this.adapterId,
      ...(this.accountId ? { accountId: this.accountId } : {}),
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

  protected setRoutingAccountId(accountId?: string): void {
    this.routingAccountId = accountId;
  }
}
