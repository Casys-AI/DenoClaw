import { assertEquals, assertRejects } from "@std/assert";
import type { BrokerMessage } from "../types.ts";
import { BrokerAgentRegistry } from "./agent_registry.ts";
import { BrokerReplyDispatcher } from "./reply_dispatch.ts";

function createReply(to = "agent-alpha"): BrokerMessage {
  return {
    id: "reply-1",
    from: "broker",
    to,
    type: "error",
    payload: {
      code: "BROKER_ERROR",
      recovery: "retry later",
    },
    timestamp: new Date().toISOString(),
  };
}

Deno.test("BrokerReplyDispatcher posts to a registered agent endpoint when no live socket is available", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  const previousToken = Deno.env.get("DENOCLAW_API_TOKEN");
  Deno.env.set("DENOCLAW_API_TOKEN", "reply-secret");
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  try {
    await kv.set(
      ["agents", "agent-alpha", "endpoint"],
      "https://agent-alpha.example",
    );

    const dispatcher = new BrokerReplyDispatcher({
      findReplySocket: () => null,
      routeToTunnel: () => {
        throw new Error("routeToTunnel should not run for HTTP wake-up");
      },
      agentRegistry: new BrokerAgentRegistry({
        getKv: () => Promise.resolve(kv),
      }),
      fetchFn: ((
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        fetchCalls.push({ url, init });
        return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
      }) as typeof fetch,
    });

    await dispatcher.sendReply(createReply());

    assertEquals(fetchCalls.length, 1);
    assertEquals(fetchCalls[0].url, "https://agent-alpha.example/tasks");
    const body = JSON.parse(String(fetchCalls[0].init?.body)) as BrokerMessage;
    assertEquals(body.to, "agent-alpha");
    assertEquals(body.type, "error");
  } finally {
    if (previousToken === undefined) {
      Deno.env.delete("DENOCLAW_API_TOKEN");
    } else {
      Deno.env.set("DENOCLAW_API_TOKEN", previousToken);
    }
    kv.close();
    await Deno.remove(kvPath);
  }
});

Deno.test("BrokerReplyDispatcher rejects when no live route exists", async () => {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    const dispatcher = new BrokerReplyDispatcher({
      findReplySocket: () => null,
      routeToTunnel: () => {
        throw new Error("routeToTunnel should not run without a live route");
      },
      agentRegistry: new BrokerAgentRegistry({
        getKv: () => Promise.resolve(kv),
      }),
    });

    await assertRejects(
      () => dispatcher.sendReply(createReply()),
      Error,
      "registered HTTP endpoint",
    );
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
