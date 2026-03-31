import { assertEquals, assertExists } from "@std/assert";
import { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";

function createMockSocket() {
  const calls: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    close(code?: number, reason?: string) {
      calls.push({ code, reason });
    },
  } as unknown as WebSocket;
  return { socket, calls };
}

Deno.test("BrokerAgentSocketRegistry replaces an existing socket for the same agent", () => {
  const registry = new BrokerAgentSocketRegistry();
  const first = createMockSocket();
  const second = createMockSocket();

  registry.register("agent-alpha", first.socket, "session:first");
  registry.register("agent-alpha", second.socket, "session:second");

  assertEquals(first.calls, [{
    code: 1000,
    reason: "Replaced by a newer agent socket",
  }]);

  const current = registry.get("agent-alpha");
  assertExists(current);
  assertEquals(current.ws, second.socket);
  assertEquals(current.authIdentity, "session:second");
});

Deno.test("BrokerAgentSocketRegistry only unregisters the current socket", () => {
  const registry = new BrokerAgentSocketRegistry();
  const first = createMockSocket();
  const second = createMockSocket();

  registry.register("agent-alpha", first.socket, "session:first");
  registry.register("agent-alpha", second.socket, "session:second");

  assertEquals(
    registry.unregisterIfCurrent("agent-alpha", first.socket),
    false,
  );
  assertExists(registry.get("agent-alpha"));

  assertEquals(
    registry.unregisterIfCurrent("agent-alpha", second.socket),
    true,
  );
  assertEquals(registry.get("agent-alpha"), null);
});
