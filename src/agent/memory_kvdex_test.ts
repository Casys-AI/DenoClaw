import { assertEquals, assertGreater } from "@std/assert";
import { KvdexMemory } from "./memory_kvdex.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: "KvdexMemory.semanticRecall always returns empty array",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-semantic-${crypto.randomUUID()}`,
      10,
      kvPath,
    );
    try {
      await mem.load();
      await mem.addMessage({ role: "user", content: "hello" });
      const result = await mem.semanticRecall("hello");
      assertEquals(result, []);
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

async function makeTempKvPath(): Promise<string> {
  return await Deno.makeTempFile({ suffix: ".db" });
}

Deno.test({
  name: "KvdexMemory stores and retrieves messages",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-${crypto.randomUUID()}`,
      10,
      kvPath,
    );
    try {
      await mem.load();

      await mem.addMessage({ role: "user", content: "hello" });
      await mem.addMessage({ role: "assistant", content: "hi back" });

      assertEquals(mem.count, 2);
      assertEquals((await mem.getMessages())[0].content, "hello");
      assertEquals((await mem.getMessages())[1].content, "hi back");
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

Deno.test({
  name: "KvdexMemory trims old messages beyond maxMessages",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-trim-${crypto.randomUUID()}`,
      3,
      kvPath,
    );
    try {
      await mem.load();

      for (let i = 0; i < 5; i++) {
        await mem.addMessage({ role: "user", content: `msg-${i}` });
      }

      const msgs = await mem.getMessages();
      assertEquals(msgs.length, 3);
      assertEquals(msgs[0].content, "msg-2");
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

Deno.test({
  name: "KvdexMemory keeps system messages during trim",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-sys-${crypto.randomUUID()}`,
      3,
      kvPath,
    );
    try {
      await mem.load();

      await mem.addMessage({ role: "system", content: "system prompt" });
      for (let i = 0; i < 5; i++) {
        await mem.addMessage({ role: "user", content: `msg-${i}` });
      }

      const msgs = await mem.getMessages();
      assertEquals(msgs[0].role, "system");
      assertEquals(msgs[0].content, "system prompt");
      assertGreater(msgs.length, 1);
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

Deno.test({
  name: "KvdexMemory clear empties all messages",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-clear-${crypto.randomUUID()}`,
      10,
      kvPath,
    );
    try {
      await mem.load();

      await mem.addMessage({ role: "user", content: "hello" });
      assertEquals(mem.count, 1);

      await mem.clear();
      assertEquals(mem.count, 0);
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

Deno.test({
  name: "KvdexMemory remember and recall long-term facts",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-lt-${crypto.randomUUID()}`,
      10,
      kvPath,
    );
    try {
      await mem.load();

      await mem.remember({
        topic: "color",
        content: "the sky is blue",
        source: "user",
      });
      await mem.remember({
        topic: "color",
        content: "grass is green",
        source: "agent",
      });
      await mem.remember({ topic: "math", content: "2+2=4" });

      const colors = await mem.recallTopic("color");
      assertEquals(colors.length, 2);
      assertEquals(colors[0].topic, "color");

      const math = await mem.recallTopic("math");
      assertEquals(math.length, 1);
      assertEquals(math[0].content, "2+2=4");
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

Deno.test({
  name: "KvdexMemory forgetTopic removes facts",
  async fn() {
    const kvPath = await makeTempKvPath();
    const mem = new KvdexMemory(
      "test",
      `sess-forget-${crypto.randomUUID()}`,
      10,
      kvPath,
    );
    try {
      await mem.load();

      await mem.remember({ topic: "temp", content: "ephemeral fact" });
      assertEquals((await mem.recallTopic("temp")).length, 1);

      await mem.forgetTopic("temp");
      assertEquals((await mem.recallTopic("temp")).length, 0);
    } finally {
      mem.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});

Deno.test({
  name: "KvdexMemory cross-session isolation",
  async fn() {
    const id = crypto.randomUUID();
    const kvPath = await makeTempKvPath();
    const mem1 = new KvdexMemory("test", `sess-a-${id}`, 10, kvPath);
    const mem2 = new KvdexMemory("test", `sess-b-${id}`, 10, kvPath);
    try {
      await mem1.load();
      await mem2.load();

      await mem1.addMessage({ role: "user", content: "for session A" });
      await mem2.addMessage({ role: "user", content: "for session B" });

      assertEquals(mem1.count, 1);
      assertEquals((await mem1.getMessages())[0].content, "for session A");
      assertEquals(mem2.count, 1);
      assertEquals((await mem2.getMessages())[0].content, "for session B");
    } finally {
      mem1.close();
      mem2.close();
      await Deno.remove(kvPath).catch(() => {});
    }
  },
  ...testOpts,
});
