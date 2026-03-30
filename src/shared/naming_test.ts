import { assertEquals } from "@std/assert";
import {
  deriveAgentAppName,
  deriveAgentKvName,
  deriveBrokerAppName,
  deriveBrokerKvName,
  deriveSandboxInstanceName,
} from "./naming.ts";

Deno.test("deriveBrokerAppName uses the canonical broker slug", () => {
  assertEquals(deriveBrokerAppName(), "denoclaw-broker");
});

Deno.test("deriveBrokerKvName uses the canonical broker KV slug", () => {
  assertEquals(deriveBrokerKvName(), "denoclaw-broker-kv");
  assertEquals(
    deriveBrokerKvName("denoclaw-custom-broker"),
    "denoclaw-custom-broker-kv",
  );
});

Deno.test("agent naming helpers use the canonical role-prefixed convention", () => {
  assertEquals(
    deriveAgentAppName(" Alice / Builder "),
    "denoclaw-agent-alice-builder",
  );
  assertEquals(
    deriveAgentKvName(" Alice / Builder "),
    "denoclaw-agent-alice-builder-kv",
  );
  assertEquals(
    deriveSandboxInstanceName(" Alice / Builder "),
    "denoclaw-agent-alice-builder-sandbox",
  );
});

Deno.test("agent naming helpers accept a custom project prefix", () => {
  assertEquals(
    deriveAgentAppName("Alice", "Casys Lab"),
    "casys-lab-agent-alice",
  );
  assertEquals(
    deriveAgentKvName("Alice", "Casys Lab"),
    "casys-lab-agent-alice-kv",
  );
  assertEquals(
    deriveSandboxInstanceName("Alice", "Casys Lab"),
    "casys-lab-agent-alice-sandbox",
  );
});
