import { assertEquals, assertThrows } from "@std/assert";
import type { A2AMessage, Task } from "../messaging/a2a/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import type { BrokerMessage } from "./types.ts";
import {
  BROKER_MESSAGE_TYPES,
  isBrokerErrorMessage,
  isBrokerFederationMessage,
  isBrokerRequestMessage,
  isBrokerResponseMessage,
  isBrokerRuntimeMessage,
  isBrokerTaskMessage,
  parseBrokerMessage,
} from "./types.ts";

function sampleA2AMessage(text: string): A2AMessage {
  return {
    messageId: "msg-1",
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

function sampleTask(): Task {
  const message = sampleA2AMessage("hello");
  return {
    id: "task-1",
    status: {
      state: "COMPLETED",
      timestamp: new Date().toISOString(),
      message,
    },
    artifacts: [],
    history: [message],
  };
}

function baseMessage<T extends BrokerMessage["type"]>(
  type: T,
  payload: Extract<BrokerMessage, { type: T }>["payload"],
): Extract<BrokerMessage, { type: T }> {
  return {
    id: "msg-1",
    from: "agent-a",
    to: "broker",
    type,
    payload,
    timestamp: new Date().toISOString(),
  } as Extract<BrokerMessage, { type: T }>;
}

Deno.test("Broker task classifier matches only canonical task messages", () => {
  const taskMessage = sampleA2AMessage("submit");
  const taskMessages: BrokerMessage[] = [
    baseMessage("task_submit", {
      targetAgent: "agent-b",
      taskId: "task-1",
      taskMessage: taskMessage,
    }),
    baseMessage("task_continue", {
      taskId: "task-1",
      continuationMessage: taskMessage,
    }),
    baseMessage("task_get", { taskId: "task-1" }),
    baseMessage("task_cancel", { taskId: "task-1" }),
    baseMessage("task_result", { task: sampleTask() }),
  ];

  for (const message of taskMessages) {
    assertEquals(isBrokerTaskMessage(message), true);
    assertEquals(isBrokerRuntimeMessage(message), false);
    assertEquals(isBrokerErrorMessage(message), false);
    assertEquals(isBrokerRequestMessage(message), true);
    assertEquals(
      isBrokerResponseMessage(message),
      message.type === "task_result",
    );
  }
});

Deno.test("Broker runtime classifier excludes task and error messages", () => {
  const runtimeMessages: BrokerMessage[] = [
    baseMessage("llm_request", {
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
    }),
    baseMessage("llm_response", {
      content: "hi",
    }),
    baseMessage("tool_request", {
      tool: "shell",
      args: { cmd: "pwd" },
    }),
    baseMessage("tool_response", {
      success: true,
      output: "ok",
    }),
  ];

  for (const message of runtimeMessages) {
    assertEquals(isBrokerRuntimeMessage(message), true);
    assertEquals(isBrokerTaskMessage(message), false);
    assertEquals(isBrokerErrorMessage(message), false);
    assertEquals(
      isBrokerRequestMessage(message),
      message.type === "llm_request" || message.type === "tool_request",
    );
    assertEquals(
      isBrokerResponseMessage(message),
      message.type === "llm_response" || message.type === "tool_response",
    );
  }

  const errorMessage = baseMessage("error", {
    code: "BROKER_ERROR",
    context: { cause: "boom" },
    recovery: "Check logs",
  });

  assertEquals(isBrokerRuntimeMessage(errorMessage), false);
  assertEquals(isBrokerTaskMessage(errorMessage), false);
  assertEquals(isBrokerErrorMessage(errorMessage), true);
  assertEquals(isBrokerRequestMessage(errorMessage), false);
  assertEquals(isBrokerResponseMessage(errorMessage), true);
});

Deno.test("Broker federation classifier isolates control-plane methods", () => {
  const federationMessages: BrokerMessage[] = [
    baseMessage("federation_link_open", {
      linkId: "link-1",
      localBrokerId: "broker-a",
      remoteBrokerId: "broker-b",
      traceId: "trace-open-1",
    }),
    baseMessage("federation_link_ack", {
      linkId: "link-1",
      remoteBrokerId: "broker-b",
      accepted: true,
      traceId: "trace-ack-1",
    }),
    baseMessage("federation_catalog_sync", {
      remoteBrokerId: "broker-b",
      agents: ["agent-1"],
      traceId: "trace-sync-1",
    }),
    baseMessage("federation_route_probe", {
      remoteBrokerId: "broker-b",
      targetAgent: "agent-1",
      taskId: "task-1",
      contextId: "ctx-1",
      traceId: "trace-probe-1",
    }),
    baseMessage("federation_link_close", {
      linkId: "link-1",
      remoteBrokerId: "broker-b",
      traceId: "trace-close-1",
    }),
  ];

  for (const message of federationMessages) {
    assertEquals(isBrokerFederationMessage(message), true);
    assertEquals(isBrokerTaskMessage(message), false);
    assertEquals(isBrokerRuntimeMessage(message), false);
    assertEquals(isBrokerErrorMessage(message), false);
    assertEquals(isBrokerRequestMessage(message), true);
    assertEquals(isBrokerResponseMessage(message), false);
  }
});

Deno.test("parseBrokerMessage accepts a valid broker envelope", () => {
  const parsed = parseBrokerMessage(baseMessage("tool_request", {
    tool: "shell",
    args: { command: "pwd" },
  }));

  assertEquals(parsed.type, "tool_request");
  assertEquals(parsed.from, "agent-a");
  assertEquals(parsed.to, "broker");
});

Deno.test("parseBrokerMessage rejects malformed broker envelopes", () => {
  assertThrows(
    () =>
      parseBrokerMessage({
        id: "msg-1",
        from: "agent-a",
        to: "broker",
        type: "not-a-real-type",
        payload: {},
        timestamp: new Date().toISOString(),
      }),
    DenoClawError,
    "BROKER_MESSAGE_INVALID",
  );

  assertThrows(
    () =>
      parseBrokerMessage({
        id: "msg-1",
        from: "agent-a",
        to: "broker",
        type: "tool_request",
        payload: [],
        timestamp: new Date().toISOString(),
      }),
    DenoClawError,
    "BROKER_MESSAGE_INVALID",
  );
});

Deno.test("BROKER_MESSAGE_TYPES stays aligned with the broker union", () => {
  assertEquals(BROKER_MESSAGE_TYPES.includes("tool_request"), true);
  assertEquals(BROKER_MESSAGE_TYPES.includes("federation_link_close"), true);
  assertEquals(BROKER_MESSAGE_TYPES.includes("error"), true);
});
