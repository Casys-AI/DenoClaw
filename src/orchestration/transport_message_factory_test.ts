import { assertEquals } from "@std/assert";
import { createBrokerRequestMessage } from "./transport_message_factory.ts";

Deno.test("createBrokerRequestMessage stamps broker requests with transport metadata", () => {
  const message = createBrokerRequestMessage("agent-1", {
    to: "broker",
    type: "llm_request",
    payload: {
      messages: [],
      model: "gpt-5",
    },
  });

  assertEquals(message.from, "agent-1");
  assertEquals(message.to, "broker");
  assertEquals(message.type, "llm_request");
  assertEquals(typeof message.id, "string");
  assertEquals(message.id.length > 0, true);
  assertEquals(typeof message.timestamp, "string");
  assertEquals(Number.isNaN(Date.parse(message.timestamp)), false);
});
