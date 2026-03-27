import type { BaseChannel } from "./base.ts";
import { getMessageBus } from "../bus.ts";
import { ChannelError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

export class ChannelManager {
  private channels = new Map<string, BaseChannel>();

  register(channel: BaseChannel): void {
    if (this.channels.has(channel.channelType)) {
      log.warn(`Channel déjà enregistré : ${channel.channelType}`);
      return;
    }
    this.channels.set(channel.channelType, channel);
    log.info(`Channel enregistré : ${channel.channelType}`);
  }

  async startAll(): Promise<void> {
    const bus = getMessageBus();

    const promises = [...this.channels.entries()]
      .filter(([_, ch]) => ch.enabled)
      .map(async ([type, ch]) => {
        try {
          await ch.start((msg) => {
            bus.publish(msg).catch((e: unknown) => log.error(`Bus publish error (${type})`, e));
          });
        } catch (e) {
          log.error(`Échec démarrage ${type}`, e);
        }
      });

    await Promise.all(promises);
    log.info("Tous les channels actifs sont démarrés");
  }

  async stopAll(): Promise<void> {
    const promises = [...this.channels.values()].map((ch) =>
      ch.stop().catch((e) => log.error(`Échec arrêt ${ch.channelType}`, e))
    );
    await Promise.all(promises);
    log.info("Tous les channels arrêtés");
  }

  async send(
    channelType: string,
    userId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const ch = this.channels.get(channelType);
    if (!ch) {
      throw new ChannelError(
        "CHANNEL_NOT_FOUND",
        { channelType, available: [...this.channels.keys()] },
        `Use one of: ${[...this.channels.keys()].join(", ")}`,
      );
    }
    await ch.send(userId, content, metadata);
  }

  getChannel(type: string): BaseChannel | undefined {
    return this.channels.get(type);
  }

  getAllStatuses(): Record<string, ReturnType<BaseChannel["getStatus"]>> {
    const result: Record<string, ReturnType<BaseChannel["getStatus"]>> = {};
    for (const [type, ch] of this.channels) result[type] = ch.getStatus();
    return result;
  }
}

let _cm: ChannelManager | null = null;
export function getChannelManager(): ChannelManager {
  if (!_cm) _cm = new ChannelManager();
  return _cm;
}
