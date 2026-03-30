import { assertEquals, assertRejects } from "@std/assert";
import { BrokerTransportRequestTracker } from "./transport_request_tracker.ts";

Deno.test("BrokerTransportRequestTracker resolves correlated responses", async () => {
  const tracker = new BrokerTransportRequestTracker<
    { id: string; ok: boolean }
  >();
  const pending = tracker.create("req-1", 50, () => new Error("timeout"));

  assertEquals(tracker.resolve({ id: "req-1", ok: true }), true);
  assertEquals(await pending, { id: "req-1", ok: true });
});

Deno.test("BrokerTransportRequestTracker rejects timed out responses", async () => {
  const tracker = new BrokerTransportRequestTracker<{ id: string }>();
  const pending = tracker.create("req-2", 0, () => new Error("timeout"));

  await assertRejects(() => pending, Error, "timeout");
});

Deno.test("BrokerTransportRequestTracker rejects all pending requests on shutdown", async () => {
  const tracker = new BrokerTransportRequestTracker<{ id: string }>();
  const pending = tracker.create("req-3", 50, () => new Error("timeout"));

  tracker.rejectAll((requestId) => new Error(`closed:${requestId}`));

  await assertRejects(() => pending, Error, "closed:req-3");
});
