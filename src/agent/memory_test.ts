import { assertEquals } from "@std/assert";
import { Memory } from "./memory.ts";

Deno.test({
  name: "Memory stores and retrieves messages",
  async fn() {
    const mem = new Memory(`test-${crypto.randomUUID()}`, 10);
    await mem.load();

    await mem.addMessage({ role: "user", content: "hello" });
    await mem.addMessage({ role: "assistant", content: "hi back" });

    assertEquals(mem.count, 2);
    assertEquals(mem.getMessages()[0].content, "hello");
    assertEquals(mem.getMessages()[1].content, "hi back");

    mem.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Memory trims old messages beyond maxMessages",
  async fn() {
    const mem = new Memory(`test-trim-${crypto.randomUUID()}`, 3);
    await mem.load();

    for (let i = 0; i < 5; i++) {
      await mem.addMessage({ role: "user", content: `msg-${i}` });
    }

    // Should keep only the last 3
    const msgs = mem.getMessages();
    assertEquals(msgs.length, 3);
    assertEquals(msgs[0].content, "msg-2");

    mem.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Memory clear empties all messages",
  async fn() {
    const mem = new Memory(`test-clear-${crypto.randomUUID()}`, 10);
    await mem.load();

    await mem.addMessage({ role: "user", content: "hello" });
    assertEquals(mem.count, 1);

    await mem.clear();
    assertEquals(mem.count, 0);

    mem.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
