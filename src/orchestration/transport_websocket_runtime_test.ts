import { assertEquals } from "@std/assert";
import { WebSocketBrokerConnectionRuntime } from "./transport_websocket_runtime.ts";
import { isAgentSocketRegisterMessage } from "./agent_socket_protocol.ts";

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  addEventListener(
    type: "open" | "error",
    listener: EventListenerOrEventListenerObject,
  ): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(
    type: "open" | "error",
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  emit(type: "open" | "error"): void {
    if (type === "open") {
      this.readyState = WebSocket.OPEN;
    }
    const event = new Event(type);
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === "function") {
        listener(event);
        continue;
      }
      listener.handleEvent(event);
    }
  }
}

Deno.test("WebSocketBrokerConnectionRuntime retries after a failed socket open", async () => {
  const sockets: FakeSocket[] = [];
  let wakeCalls = 0;
  const runtime = new WebSocketBrokerConnectionRuntime({
    agentId: "agent-alpha",
    brokerUrl: "https://denoclaw.casys.deno.net",
    endpoint: "https://agent.example.test",
    resolveAuthToken: () => Promise.resolve("secret-token"),
    onSocketMessage: () => {},
    onSocketClose: () => {},
    wakeBroker: () => {
      wakeCalls += 1;
      return Promise.resolve();
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        if (sockets.length === 1) {
          socket.emit("error");
          return;
        }
        socket.emit("open");
      });
      return socket;
    },
    delayMs: 0,
  });

  const socket = await runtime.connect();

  assertEquals(wakeCalls, 2);
  assertEquals(sockets.length, 2);
  assertEquals(socket, sockets[1]);
  assertEquals(sockets[0].closeCalls, [{
    code: 1013,
    reason: "Retrying broker connection",
  }]);
  assertEquals(sockets[1].sent.length, 1);
  const registerMessage = JSON.parse(sockets[1].sent[0]);
  if (!isAgentSocketRegisterMessage(registerMessage)) {
    throw new Error("expected register_agent message");
  }
  assertEquals(registerMessage.endpoint, "https://agent.example.test");
});
