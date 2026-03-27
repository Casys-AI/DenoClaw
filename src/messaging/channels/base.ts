import type { ChannelMessage } from "../types.ts";
import { log } from "../../shared/log.ts";

export type OnMessage = (message: ChannelMessage) => void;

/**
 * Abstract channel — simplified vs nano-claw: no EventEmitter,
 * uses a callback pattern instead.
 */
export abstract class BaseChannel {
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
  abstract send(userId: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
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
    if (!ok) log.warn(`Utilisateur non autorisé : ${userId} sur ${this.channelType}`);
    return ok;
  }
}
