import { assertEquals, assertRejects } from "@std/assert";
import { DenoClawError } from "../../shared/errors.ts";
import { resolveGatewayInteractiveRoutePlan } from "./interactive_route.ts";

Deno.test("resolveGatewayInteractiveRoutePlan builds a direct route plan", () => {
  assertEquals(
    resolveGatewayInteractiveRoutePlan({
      agentId: "agent-alpha",
      model: "openai/gpt-5.4",
    }),
    {
      delivery: "direct",
      targetAgentIds: ["agent-alpha"],
      primaryAgentId: "agent-alpha",
      metadata: { model: "openai/gpt-5.4" },
    },
  );
});

Deno.test("resolveGatewayInteractiveRoutePlan builds a broadcast route plan", () => {
  assertEquals(
    resolveGatewayInteractiveRoutePlan({
      agentIds: ["agent-alpha", "agent-beta"],
      delivery: "broadcast",
    }),
    {
      delivery: "broadcast",
      targetAgentIds: ["agent-alpha", "agent-beta"],
    },
  );
});

Deno.test("resolveGatewayInteractiveRoutePlan rejects conflicting direct and shared inputs", async () => {
  await assertRejects(
    async () =>
      await Promise.resolve(
        resolveGatewayInteractiveRoutePlan({
          agentId: "agent-alpha",
          agentIds: ["agent-beta"],
        }),
      ),
    DenoClawError,
    "Provide either 'agentId' for direct delivery or 'agentIds' for shared delivery, not both",
  );
});
