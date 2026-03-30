import { assertEquals } from "@std/assert";
import { MessageBus } from "./bus.ts";
import type { ChannelMessage } from "./types.ts";

const kvOpts = { sanitizeResources: false, sanitizeOps: false };

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

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

Deno.test({
  name: "MessageBus dispatches to channel-specific handlers",
  ...kvOpts,
  async fn() {
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
      await waitFor(() => received.length >= 1);
      assertEquals(received, ["hello"]);
      bus.close();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
});

Deno.test({
  name: "MessageBus dispatches to global handlers",
  ...kvOpts,
  async fn() {
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
      await waitFor(() => received.length >= 2);
      assertEquals(received.toSorted(), ["a", "b"]);
      bus.close();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
});

Deno.test({
  name: "MessageBus ignores unrelated channel handlers",
  ...kvOpts,
  async fn() {
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
      await new Promise((r) => setTimeout(r, 300));
      assertEquals(called, false);
      bus.close();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
});

Deno.test({
  name: "MessageBus clear removes all handlers",
  ...kvOpts,
  async fn() {
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
      await new Promise((r) => setTimeout(r, 300));
      assertEquals(called, false);
      bus.close();
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
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
