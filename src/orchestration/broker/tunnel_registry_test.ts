import { assertEquals, assertThrows } from "@std/assert";
import type { BrokerMessage } from "../types.ts";
import {
  sendBrokerMessageOverTunnel,
  TunnelRegistry,
} from "./tunnel_registry.ts";
import { WS_BUFFERED_AMOUNT_HIGH_WATERMARK } from "../tunnel_protocol.ts";

Deno.test("TunnelRegistry.findReplySocket prefers instance tunnels over local allowlists", () => {
  const registry = new TunnelRegistry();
  const localMessages: BrokerMessage[] = [];
  const instanceMessages: BrokerMessage[] = [];

  const localSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(raw: string) {
      localMessages.push(JSON.parse(raw) as BrokerMessage);
    },
  } as unknown as WebSocket;
  const instanceSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(raw: string) {
      instanceMessages.push(JSON.parse(raw) as BrokerMessage);
    },
  } as unknown as WebSocket;

  registry.register("shadow-local", localSocket, {
    tunnelId: "shadow-local",
    type: "local",
    tools: [],
    allowedAgents: ["agent-remote"],
  });
  registry.register("broker-remote", instanceSocket, {
    tunnelId: "broker-remote",
    type: "instance",
    tools: [],
    agents: ["agent-remote"],
    allowedAgents: [],
  });

  const socket = registry.findReplySocket("agent-remote");
  assertEquals(socket, instanceSocket);

  sendBrokerMessageOverTunnel(socket!, {
    id: "task-1",
    from: "broker-local",
    to: "agent-remote",
    type: "task_result",
    payload: { task: null },
    timestamp: new Date().toISOString(),
  });

  assertEquals(instanceMessages.length, 1);
  assertEquals(localMessages.length, 0);
});

Deno.test("TunnelRegistry exposes declared tool permissions once per tool", () => {
  const registry = new TunnelRegistry();

  registry.register("tooling-a", {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
  } as unknown as WebSocket, {
    tunnelId: "tooling-a",
    type: "local",
    tools: ["shell"],
    toolPermissions: {
      shell: ["run"],
      fs_read: ["read"],
    },
    allowedAgents: [],
  });
  registry.register("tooling-b", {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
  } as unknown as WebSocket, {
    tunnelId: "tooling-b",
    type: "local",
    tools: ["shell"],
    toolPermissions: {
      shell: ["run", "read"],
    },
    allowedAgents: [],
  });

  assertEquals(registry.getDeclaredToolPermissions(), {
    shell: ["run"],
    fs_read: ["read"],
  });
});

Deno.test("sendBrokerMessageOverTunnel rejects saturated sockets", () => {
  const saturatedSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: WS_BUFFERED_AMOUNT_HIGH_WATERMARK + 1,
    send() {
      throw new Error("send should not be called for saturated tunnel");
    },
  } as unknown as WebSocket;

  assertThrows(
    () =>
      sendBrokerMessageOverTunnel(saturatedSocket, {
        id: "msg-backpressure",
        from: "broker",
        to: "agent-beta",
        type: "task_result",
        payload: { task: null },
        timestamp: new Date().toISOString(),
      }),
    Error,
    "Tunnel is saturated",
  );
});
