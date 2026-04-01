import type { BaseChannel } from "./base.ts";
import type { ChannelAddress, OutboundChannelMessage } from "../types.ts";
import type { MessageBus } from "../bus.ts";
import { ChannelError } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";

export class ChannelManager {
  private channels = new Map<string, BaseChannel>();
  private bus: MessageBus;

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  register(channel: BaseChannel): void {
    if (this.channels.has(channel.adapterId)) {
      log.warn(`Channel already registered: ${channel.adapterId}`);
      return;
    }
    this.channels.set(channel.adapterId, channel);
    log.info(
      `Channel registered: ${channel.adapterId} (${channel.channelType})`,
    );
  }

  async startAll(): Promise<void> {
    const promises = [...this.channels.entries()]
      .filter(([_, ch]) => ch.enabled)
      .map(async ([adapterId, ch]) => {
        try {
          await ch.start(async (msg) => {
            try {
              await this.bus.publish(msg);
            } catch (e) {
              log.error(`Bus publish error (${adapterId})`, e);
              throw e;
            }
          });
        } catch (e) {
          log.error(`Failed to start ${adapterId}`, e);
        }
      });

    await Promise.all(promises);
    log.info("All active channels started");
  }

  async stopAll(): Promise<void> {
    const promises = [...this.channels.values()].map((ch) =>
      ch.stop().catch((e) => log.error(`Failed to stop ${ch.adapterId}`, e))
    );
    await Promise.all(promises);
    log.info("All channels stopped");
  }

  async sendMessage(
    channelType: string,
    message: OutboundChannelMessage,
  ): Promise<void> {
    const ch = this.resolveChannel(channelType, message.address);
    await ch.send(message);
  }

  async send(
    channelType: string,
    userId: string,
    content: string,
    metadata?: Record<string, unknown>,
    addressOverrides?: Partial<ChannelAddress>,
  ): Promise<void> {
    await this.sendMessage(channelType, {
      address: {
        channelType,
        userId,
        roomId: userId,
        ...(addressOverrides ?? {}),
      },
      content,
      metadata,
    });
  }

  getChannel(type: string, accountId?: string): BaseChannel | undefined {
    const matching = this.listChannelsByType(type);
    if (matching.length === 0) return undefined;
    if (typeof accountId === "string") {
      return matching.find((channel) => channel.accountId === accountId);
    }
    return matching.length === 1 ? matching[0] : undefined;
  }

  getAllStatuses(): Record<string, ReturnType<BaseChannel["getStatus"]>> {
    const result: Record<string, ReturnType<BaseChannel["getStatus"]>> = {};
    for (const [adapterId, ch] of this.channels) {
      result[adapterId] = ch.getStatus();
    }
    return result;
  }

  private listChannelsByType(channelType: string): BaseChannel[] {
    return [...this.channels.values()].filter((channel) =>
      channel.channelType === channelType
    );
  }

  private resolveChannel(
    channelType: string,
    address: ChannelAddress,
  ): BaseChannel {
    const matchingChannels = this.listChannelsByType(channelType);
    if (matchingChannels.length === 0) {
      throw new ChannelError(
        "CHANNEL_NOT_FOUND",
        { channelType, available: [...this.channels.keys()] },
        `Use one of: ${[...this.channels.keys()].join(", ")}`,
      );
    }

    if (address.accountId) {
      const accountMatches = matchingChannels.filter((channel) =>
        channel.accountId === address.accountId
      );
      if (accountMatches.length === 1) return accountMatches[0];
      if (accountMatches.length > 1) {
        throw new ChannelError(
          "CHANNEL_ACCOUNT_AMBIGUOUS",
          {
            channelType,
            accountId: address.accountId,
            matchingAdapters: accountMatches.map((channel) =>
              channel.adapterId
            ),
          },
          "Give each channel adapter a unique accountId for this channel type",
        );
      }
      throw new ChannelError(
        "CHANNEL_ACCOUNT_NOT_FOUND",
        {
          channelType,
          accountId: address.accountId,
          availableAccounts: matchingChannels
            .map((channel) => channel.accountId)
            .filter((value): value is string => typeof value === "string"),
        },
        "Configure a channel adapter for this accountId before sending replies",
      );
    }

    if (matchingChannels.length === 1) return matchingChannels[0];

    throw new ChannelError(
      "CHANNEL_ACCOUNT_REQUIRED",
      {
        channelType,
        availableAccounts: matchingChannels
          .map((channel) => ({
            adapterId: channel.adapterId,
            accountId: channel.accountId,
          })),
      },
      "Provide address.accountId when multiple adapters share the same channel type",
    );
  }
}
