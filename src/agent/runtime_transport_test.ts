import { assertEquals, assertThrows } from "@std/assert";
import type { BrokerEnvelope } from "../shared/types.ts";
import {
  assertRuntimeTaskMessage,
  extractContinuationTaskMessage,
  extractSubmitTaskMessage,
  isRuntimeTaskMessage,
} from "./runtime_transport.ts";

function envelope(type: string): BrokerEnvelope {
  return {
    id: "msg-1",
    from: "broker",
    to: "agent-beta",
    type,
    payload: {},
    timestamp: new Date().toISOString(),
  };
}

Deno.test("runtime transport guard accepts only canonical broker task messages", () => {
  assertEquals(isRuntimeTaskMessage(envelope("task_submit")), true);
  assertEquals(isRuntimeTaskMessage(envelope("task_continue")), true);
  assertEquals(isRuntimeTaskMessage(envelope("tool_response")), false);
  assertEquals(isRuntimeTaskMessage(envelope("error")), false);
});

Deno.test("runtime transport assertion rejects non-canonical broker envelopes", () => {
  assertThrows(
    () => {
      assertRuntimeTaskMessage(envelope("tool_response"));
    },
    Error,
    "INVALID_BROKER_MESSAGE",
  );
});

Deno.test("runtime transport extractors use canonical fields", () => {
  const canonicalInput = {
    messageId: "m1",
    role: "user" as const,
    parts: [{ kind: "text" as const, text: "hello" }],
  };

  assertEquals(
    extractSubmitTaskMessage({ taskId: "t1", taskMessage: canonicalInput }),
    canonicalInput,
  );
  assertEquals(
    extractContinuationTaskMessage({
      taskId: "t1",
      continuationMessage: canonicalInput,
    }),
    canonicalInput,
  );
});
