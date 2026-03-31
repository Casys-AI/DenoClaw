import { assertEquals, assertRejects } from "@std/assert";
import type { MessageBus } from "../bus.ts";
import type { OutboundChannelMessage } from "../types.ts";
import { BaseChannel, type OnMessage } from "./base.ts";
import { ChannelManager } from "./manager.ts";
import { ChannelError } from "../../shared/errors.ts";

class StubChannel extends BaseChannel {
  sent: OutboundChannelMessage[] = [];

  constructor(channelType: string, adapterId: string, accountId?: string) {
    super(channelType, { adapterId, accountId });
    this.enabled = true;
  }

  async initialize(): Promise<void> {
    await Promise.resolve();
  }

  async start(_onMessage: OnMessage): Promise<void> {
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    await Promise.resolve();
  }

  send(message: OutboundChannelMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  isConnected(): boolean {
    return true;
  }
}

function createManager(): ChannelManager {
  const bus = {
    publish: () => Promise.resolve(),
  } as unknown as MessageBus;
  return new ChannelManager(bus);
}

Deno.test(
  "ChannelManager routes a single channel type without requiring accountId",
  async () => {
    const manager = createManager();
    const channel = new StubChannel("telegram", "telegram");
    manager.register(channel);

    await manager.sendMessage("telegram", {
      address: { channelType: "telegram", roomId: "123" },
      content: "hello",
    });

    assertEquals(channel.sent.length, 1);
    assertEquals(manager.getAllStatuses(), {
      telegram: {
        type: "telegram",
        adapterId: "telegram",
        enabled: true,
        connected: true,
      },
    });
  },
);

Deno.test(
  "ChannelManager routes to the matching accountId when multiple adapters share a type",
  async () => {
    const manager = createManager();
    const sales = new StubChannel("telegram", "telegram:sales", "sales-bot");
    const support = new StubChannel(
      "telegram",
      "telegram:support",
      "support-bot",
    );
    manager.register(sales);
    manager.register(support);

    await manager.sendMessage("telegram", {
      address: {
        channelType: "telegram",
        accountId: "support-bot",
        roomId: "123",
      },
      content: "hello",
    });

    assertEquals(sales.sent.length, 0);
    assertEquals(support.sent.length, 1);
  },
);

Deno.test(
  "ChannelManager rejects outbound sends without accountId when multiple adapters share a type",
  async () => {
    const manager = createManager();
    manager.register(
      new StubChannel("telegram", "telegram:sales", "sales-bot"),
    );
    manager.register(
      new StubChannel("telegram", "telegram:support", "support-bot"),
    );

    await assertRejects(
      () =>
        manager.sendMessage("telegram", {
          address: { channelType: "telegram", roomId: "123" },
          content: "hello",
        }),
      ChannelError,
      "Provide address.accountId when multiple adapters share the same channel type",
    );
  },
);
