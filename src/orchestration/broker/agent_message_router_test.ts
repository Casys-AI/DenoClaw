import { assertEquals, assertRejects } from "@std/assert";
import type { BrokerTaskSubmitMessage } from "../types.ts";
import { BrokerAgentRegistry } from "./agent_registry.ts";
import { BrokerAgentMessageRouter } from "./agent_message_router.ts";
import { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import { TunnelRegistry } from "./tunnel_registry.ts";

function createTaskSubmitMessage(): BrokerTaskSubmitMessage {
  return {
    id: "msg-task-submit",
    from: "agent-alpha",
    to: "agent-beta",
    type: "task_submit",
    payload: {
      targetAgent: "agent-beta",
      taskId: "task-123",
      contextId: "ctx-123",
      taskMessage: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Summarize this" }],
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function waitForQueuedMessage(
  kv: Deno.Kv,
  predicate: (message: BrokerTaskSubmitMessage) => boolean,
): Promise<BrokerTaskSubmitMessage> {
  let settled = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Timed out waiting for queued message"));
    }, 5_000);

    kv.listenQueue((raw: unknown) => {
      if (settled) return;
      const message = raw as BrokerTaskSubmitMessage;
      if (!predicate(message)) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

Deno.test(
  "BrokerAgentMessageRouter posts to a registered agent endpoint before KV fallback",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const previousToken = Deno.env.get("DENOCLAW_API_TOKEN");
    Deno.env.set("DENOCLAW_API_TOKEN", "wake-secret");
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    try {
      await kv.set(
        ["agents", "agent-beta", "endpoint"],
        "https://agent-beta.example",
      );

      const router = new BrokerAgentMessageRouter({
        getKv: () => Promise.resolve(kv),
        metrics: {
          recordAgentMessage: () => Promise.resolve(),
        },
        connectedAgents: new BrokerAgentSocketRegistry(),
        agentRegistry: new BrokerAgentRegistry({
          getKv: () => Promise.resolve(kv),
        }),
        tunnelRegistry: new TunnelRegistry(),
        routeToTunnel: () => {
          throw new Error("routeToTunnel should not run for HTTP wake-up");
        },
        fetchFn: ((
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          const url = input instanceof Request ? input.url : String(input);
          fetchCalls.push({ url, init });
          return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
        }) as typeof fetch,
      });

      await router.routeTaskMessage("agent-beta", createTaskSubmitMessage());

      assertEquals(fetchCalls.length, 1);
      assertEquals(fetchCalls[0].url, "https://agent-beta.example/tasks");
      assertEquals(fetchCalls[0].init?.headers, {
        "content-type": "application/json",
        authorization: "Bearer wake-secret",
      });

      const body = JSON.parse(
        String(fetchCalls[0].init?.body),
      ) as BrokerTaskSubmitMessage;
      assertEquals(body.type, "task_submit");
      assertEquals(body.payload.taskId, "task-123");
    } finally {
      if (previousToken === undefined) {
        Deno.env.delete("DENOCLAW_API_TOKEN");
      } else {
        Deno.env.set("DENOCLAW_API_TOKEN", previousToken);
      }
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerAgentMessageRouter falls back to KV queue when no live route exists",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      const queuedMessage = waitForQueuedMessage(
        kv,
        (message) =>
          message.type === "task_submit" &&
          message.payload.taskId === "task-123",
      );

      const router = new BrokerAgentMessageRouter({
        getKv: () => Promise.resolve(kv),
        metrics: {
          recordAgentMessage: () => Promise.resolve(),
        },
        connectedAgents: new BrokerAgentSocketRegistry(),
        agentRegistry: new BrokerAgentRegistry({
          getKv: () => Promise.resolve(kv),
        }),
        tunnelRegistry: new TunnelRegistry(),
        routeToTunnel: () => {
          throw new Error("routeToTunnel should not run for KV fallback");
        },
      });

      await router.routeTaskMessage("agent-beta", createTaskSubmitMessage());

      const queued = await queuedMessage;
      assertEquals(queued.type, "task_submit");
      assertEquals(queued.to, "agent-beta");
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);

Deno.test(
  "BrokerAgentMessageRouter surfaces endpoint delivery failures with structured broker errors",
  async () => {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);

    try {
      await kv.set(
        ["agents", "agent-beta", "endpoint"],
        "https://agent-beta.example",
      );

      const router = new BrokerAgentMessageRouter({
        getKv: () => Promise.resolve(kv),
        metrics: {
          recordAgentMessage: () => Promise.resolve(),
        },
        connectedAgents: new BrokerAgentSocketRegistry(),
        agentRegistry: new BrokerAgentRegistry({
          getKv: () => Promise.resolve(kv),
        }),
        tunnelRegistry: new TunnelRegistry(),
        routeToTunnel: () => {
          throw new Error("routeToTunnel should not run for HTTP wake-up");
        },
        fetchFn: (() =>
          Promise.resolve(
            new Response("boom", { status: 503 }),
          )) as typeof fetch,
      });

      await assertRejects(
        () => router.routeTaskMessage("agent-beta", createTaskSubmitMessage()),
        Error,
        "AGENT_ENDPOINT_DELIVERY_FAILED",
      );
    } finally {
      kv.close();
      await Deno.remove(kvPath);
    }
  },
);
