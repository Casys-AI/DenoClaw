import { assertEquals, assertRejects } from "@std/assert";
import { DenoClawError } from "../../shared/errors.ts";
import { createDirectChannelRoutePlan } from "../channel_routing/types.ts";
import {
  getExplicitChannelMessageAgentId,
  requireDirectChannelIngressRoute,
  requireDirectChannelIngressRouteFromPlan,
} from "./direct_route.ts";

function createMessage(metadata?: Record<string, unknown>) {
  return {
    id: "msg-1",
    sessionId: "session-1",
    userId: "user-1",
    content: "hello",
    channelType: "telegram",
    timestamp: new Date().toISOString(),
    address: {
      channelType: "telegram",
      roomId: "room-1",
      userId: "user-1",
    },
    ...(metadata ? { metadata } : {}),
  };
}

Deno.test("getExplicitChannelMessageAgentId trims message metadata agentId", () => {
  assertEquals(
    getExplicitChannelMessageAgentId(
      createMessage({ agentId: " agent-beta " }),
    ),
    "agent-beta",
  );
});

Deno.test("requireDirectChannelIngressRoute honors explicit route input", () => {
  assertEquals(
    requireDirectChannelIngressRoute(createMessage(), {
      agentId: "agent-alpha",
      contextId: "ctx-1",
      metadata: { model: "openai/gpt-5.4" },
    }),
    {
      agentId: "agent-alpha",
      contextId: "ctx-1",
      metadata: { model: "openai/gpt-5.4" },
    },
  );
});

Deno.test(
  "requireDirectChannelIngressRoute falls back to message metadata agentId",
  () => {
    assertEquals(
      requireDirectChannelIngressRoute(
        createMessage({ agentId: "agent-beta" }),
      ),
      { agentId: "agent-beta" },
    );
  },
);

Deno.test(
  "requireDirectChannelIngressRoute rejects missing direct ingress target",
  async () => {
    await assertRejects(
      async () =>
        await Promise.resolve(
          requireDirectChannelIngressRoute(createMessage()),
        ),
      DenoClawError,
      "Provide a direct ingress target via route.agentId or message.metadata.agentId",
    );
  },
);

Deno.test(
  "requireDirectChannelIngressRouteFromPlan bridges a direct route plan",
  () => {
    assertEquals(
      requireDirectChannelIngressRouteFromPlan(
        createMessage(),
        createDirectChannelRoutePlan("agent-alpha", {
          contextId: "ctx-1",
          metadata: { model: "openai/gpt-5.4" },
        }),
      ),
      {
        agentId: "agent-alpha",
        contextId: "ctx-1",
        metadata: { model: "openai/gpt-5.4" },
      },
    );
  },
);

Deno.test(
  "requireDirectChannelIngressRouteFromPlan rejects non-direct delivery",
  async () => {
    await assertRejects(
      async () =>
        await Promise.resolve(
          requireDirectChannelIngressRouteFromPlan(
            createMessage(),
            {
              delivery: "broadcast",
              targetAgentIds: ["agent-alpha", "agent-beta"],
            },
          ),
        ),
      DenoClawError,
      "Current channel ingress execution supports only direct delivery",
    );
  },
);
