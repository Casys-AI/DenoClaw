import { assertEquals } from "@std/assert";
import { InMemoryEventStore } from "./event_store.ts";
import type { CompleteEvent, LlmRequestEvent } from "./events.ts";

Deno.test("InMemoryEventStore stores and retrieves events", async () => {
  const store = new InMemoryEventStore();
  const e1: LlmRequestEvent = {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request", messages: [], tools: [], config: { model: "test" },
  };
  const e2: CompleteEvent = {
    eventId: 1, timestamp: Date.now(), iterationId: 1,
    type: "complete", content: "done",
  };
  await store.commit(e1);
  await store.commit(e2);
  const events = await store.getEvents();
  assertEquals(events.length, 2);
  assertEquals(events[0].type, "llm_request");
  assertEquals(events[1].type, "complete");
});
