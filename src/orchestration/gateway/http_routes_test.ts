import { assertEquals } from "@std/assert";
import { SessionManager } from "../../messaging/session.ts";
import { createCanonicalTask } from "../../messaging/a2a/internal_contract.ts";
import type { Task } from "../../messaging/a2a/types.ts";
import { InProcessBrokerChannelIngressClient } from "../channel_ingress/in_process.ts";
import type { ChannelRoutePlan } from "../channel_routing/types.ts";
import { type GatewayHttpContext, handleGatewayHttp } from "./http_routes.ts";

const baseConfig = {
  agents: { defaults: {}, registry: {} },
  providers: {},
  tools: {},
} as const;

Deno.test({
  name: "handleGatewayHttp /chat routes model override through channel ingress",
  async fn() {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const session = new SessionManager(kv);
    const observed: {
      route?: ChannelRoutePlan;
      metadata?: Record<string, unknown>;
      channelType?: string;
    } = {};

    const task = createCanonicalTask({
      id: "task-http-1",
      contextId: "session-http-1",
      initialMessage: {
        messageId: "msg-http-1",
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
      },
    });
    task.status.state = "COMPLETED";
    task.artifacts.push({
      artifactId: "artifact-1",
      parts: [{ kind: "text", text: "pong" }],
    });

    const ctx: GatewayHttpContext = {
      config: baseConfig as GatewayHttpContext["config"],
      session,
      channels: {} as GatewayHttpContext["channels"],
      channelIngress: new InProcessBrokerChannelIngressClient({
        submit(message, route) {
          observed.route = route;
          observed.metadata = route?.metadata;
          observed.channelType = message.channelType;
          return Promise.resolve({
            task,
            taskId: task.id,
            contextId: task.contextId,
          });
        },
        getTask: (_taskId: string) => Promise.resolve(null as Task | null),
        continueTask: (_taskId: string) => Promise.resolve(null as Task | null),
      }),
      workerPool: {} as GatewayHttpContext["workerPool"],
      metrics: null,
      kv,
      freshHandler: null,
      dashboardBasePath: "/dashboard",
      rateLimiter: null,
      githubOAuth: null,
      agentStore: null,
      checkAuth: () => Promise.resolve(null),
      handleWebSocketUpgrade: () => new Response("upgrade"),
    };

    try {
      const response = await handleGatewayHttp(
        ctx,
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "agent-alpha",
            sessionId: "session-http-1",
            message: "hello",
            model: "openai/gpt-5.4",
          }),
        }),
      );

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.taskId, "task-http-1");
      assertEquals(body.response, "pong");
      assertEquals(observed, {
        route: {
          delivery: "direct",
          targetAgentIds: ["agent-alpha"],
          primaryAgentId: "agent-alpha",
          metadata: { model: "openai/gpt-5.4" },
        },
        metadata: { model: "openai/gpt-5.4" },
        channelType: "http",
      });
    } finally {
      session.close();
      await Deno.remove(kvPath);
    }
  },
});

Deno.test({
  name: "handleGatewayHttp /chat accepts shared broadcast routing inputs",
  async fn() {
    const kvPath = await Deno.makeTempFile({ suffix: ".db" });
    const kv = await Deno.openKv(kvPath);
    const session = new SessionManager(kv);
    const observed: {
      route?: ChannelRoutePlan;
      channelType?: string;
    } = {};

    const task = createCanonicalTask({
      id: "task-http-broadcast-1",
      contextId: "session-http-broadcast-1",
      initialMessage: {
        messageId: "msg-http-broadcast-1",
        role: "user",
        parts: [{ kind: "text", text: "hello broadcast" }],
      },
    });
    task.status.state = "COMPLETED";
    task.artifacts.push({
      artifactId: "artifact-broadcast-1",
      parts: [{
        kind: "text",
        text: "[agent-alpha] pong\n\n[agent-beta] pong",
      }],
    });

    const ctx: GatewayHttpContext = {
      config: baseConfig as GatewayHttpContext["config"],
      session,
      channels: {} as GatewayHttpContext["channels"],
      channelIngress: new InProcessBrokerChannelIngressClient({
        submit(message, route) {
          observed.route = route;
          observed.channelType = message.channelType;
          return Promise.resolve({
            task,
            taskId: task.id,
            contextId: task.contextId,
          });
        },
        getTask: (_taskId: string) => Promise.resolve(null as Task | null),
        continueTask: (_taskId: string) => Promise.resolve(null as Task | null),
      }),
      workerPool: {} as GatewayHttpContext["workerPool"],
      metrics: null,
      kv,
      freshHandler: null,
      dashboardBasePath: "/dashboard",
      rateLimiter: null,
      githubOAuth: null,
      agentStore: null,
      checkAuth: () => Promise.resolve(null),
      handleWebSocketUpgrade: () => new Response("upgrade"),
    };

    try {
      const response = await handleGatewayHttp(
        ctx,
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentIds: ["agent-alpha", "agent-beta"],
            delivery: "broadcast",
            sessionId: "session-http-broadcast-1",
            message: "hello broadcast",
          }),
        }),
      );

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.taskId, "task-http-broadcast-1");
      assertEquals(body.response, "[agent-alpha] pong\n\n[agent-beta] pong");
      assertEquals(observed, {
        route: {
          delivery: "broadcast",
          targetAgentIds: ["agent-alpha", "agent-beta"],
        },
        channelType: "http",
      });
    } finally {
      session.close();
      await Deno.remove(kvPath);
    }
  },
});
