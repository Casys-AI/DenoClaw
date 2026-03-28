import { assertEquals } from "@std/assert";
import { MessageBus } from "./bus.ts";
import type { ChannelMessage } from "./types.ts";

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
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const bus = new MessageBus(kv);
    await bus.init();
    const received: string[] = [];

    bus.subscribe("test", async (msg) => {
      received.push(msg.content);
      await Promise.resolve();
    });

    await bus.publish(makeMsg("test"));
    // KV Queue dispatch is async — wait for delivery
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(received, ["hello"]);
    bus.close();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("MessageBus dispatches to global handlers", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const bus = new MessageBus(kv);
    await bus.init();
    const received: string[] = [];

    bus.subscribeAll(async (msg) => {
      received.push(msg.channelType);
      await Promise.resolve();
    });

    await bus.publish(makeMsg("a"));
    await bus.publish(makeMsg("b"));
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(received, ["a", "b"]);
    bus.close();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("MessageBus ignores unrelated channel handlers", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const bus = new MessageBus(kv);
    await bus.init();
    let called = false;

    bus.subscribe("other", async () => {
      called = true;
      await Promise.resolve();
    });

    await bus.publish(makeMsg("test"));
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(called, false);
    bus.close();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("MessageBus clear removes all handlers", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  try {
    const bus = new MessageBus(kv);
    await bus.init();
    let called = false;

    bus.subscribeAll(async () => {
      called = true;
      await Promise.resolve();
    });

    bus.clear();
    await bus.publish(makeMsg("test"));
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(called, false);
    bus.close();
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("MessageBus.publish throws if not initialized", async () => {
  const bus = new MessageBus();
  let threw = false;
  try {
    await bus.publish(makeMsg("test"));
  } catch (e) {
    threw = true;
    assertEquals((e as { code: string }).code, "BUS_NOT_INITIALIZED");
  }
  assertEquals(threw, true);
  bus.close();
});
