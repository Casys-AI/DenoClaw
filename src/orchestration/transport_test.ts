import { assertEquals } from "@std/assert";
import {
  resolveAgentSocketUrl,
  resolveAuthenticatedAgentSocketUrl,
} from "./transport.ts";

Deno.test("resolveAgentSocketUrl upgrades broker URL to agent websocket URL", () => {
  assertEquals(
    resolveAgentSocketUrl("https://denoclaw.casys.deno.net"),
    "wss://denoclaw.casys.deno.net/agent/socket",
  );
  assertEquals(
    resolveAgentSocketUrl("http://localhost:3000"),
    "ws://localhost:3000/agent/socket",
  );
});

Deno.test("resolveAuthenticatedAgentSocketUrl appends the broker token as a query param", () => {
  assertEquals(
    resolveAuthenticatedAgentSocketUrl(
      "https://denoclaw.casys.deno.net",
      "secret-token",
    ),
    "wss://denoclaw.casys.deno.net/agent/socket?token=secret-token",
  );
  assertEquals(
    resolveAuthenticatedAgentSocketUrl(
      "wss://denoclaw.casys.deno.net/agent/socket",
      "secret-token",
    ),
    "wss://denoclaw.casys.deno.net/agent/socket?token=secret-token",
  );
});
