import { assertEquals } from "@std/assert";
import { MessageBus } from "./mod.ts";
import type { ChannelMessage } from "../types.ts";

function makeMsg(channelType = "test"): ChannelMessage {
  return {
    id: crypto.randomUUID(),
    sessionId: "s1",
    userId: "u1",
    content: "hello",
    channelType,
    timestamp: new Date().toISOString(),
  };
}

Deno.test("MessageBus dispatches to channel-specific handlers", async () => {
  const bus = new MessageBus();
  // Don't init KV for unit test — uses fallback in-memory dispatch
  const received: string[] = [];

  bus.subscribe("test", async (msg) => {
    received.push(msg.content);
    await Promise.resolve();
  });

  await bus.publish(makeMsg("test"));
  assertEquals(received, ["hello"]);
  bus.close();
});

Deno.test("MessageBus dispatches to global handlers", async () => {
  const bus = new MessageBus();
  const received: string[] = [];

  bus.subscribeAll(async (msg) => {
    received.push(msg.channelType);
    await Promise.resolve();
  });

  await bus.publish(makeMsg("a"));
  await bus.publish(makeMsg("b"));
  assertEquals(received, ["a", "b"]);
  bus.close();
});

Deno.test("MessageBus ignores unrelated channel handlers", async () => {
  const bus = new MessageBus();
  let called = false;

  bus.subscribe("other", async () => {
    called = true;
    await Promise.resolve();
  });

  await bus.publish(makeMsg("test"));
  assertEquals(called, false);
  bus.close();
});

Deno.test("MessageBus clear removes all handlers", async () => {
  const bus = new MessageBus();
  let called = false;

  bus.subscribeAll(async () => {
    called = true;
    await Promise.resolve();
  });

  bus.clear();
  await bus.publish(makeMsg("test"));
  assertEquals(called, false);
  bus.close();
});
