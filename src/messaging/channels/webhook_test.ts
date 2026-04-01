import { assertEquals, assertMatch } from "@std/assert";
import { WebhookChannel } from "./webhook.ts";
import type { ChannelMessage } from "../types.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: "WebhookChannel accepts messages and returns a generated taskId",
  async fn() {
    let invokeHandler: (req: Request) => Promise<Response> = () => {
      throw new Error("WebhookChannel did not register an HTTP handler");
    };
    const channel = new WebhookChannel(
      { enabled: true, port: 8787 },
      {
        serve: ((_options, nextHandler) => {
          invokeHandler = async (req: Request) => await nextHandler(req);
          return {
            addr: { transport: "tcp", hostname: "127.0.0.1", port: 8787 },
            finished: Promise.resolve(),
            shutdown: async () => {},
            ref: () => {},
            unref: () => {},
          } as Deno.HttpServer;
        }),
      },
    );
    const observedMessages: ChannelMessage[] = [];

    try {
      channel.start((message) => {
        observedMessages.push(message);
      });

      const response = await invokeHandler(new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "web-user",
          content: "hello",
          agentId: "agent-alpha",
        }),
      }));

      assertEquals(response.status, 202);
      const body = await response.json();
      assertEquals(body.ok, true);
      assertEquals(body.accepted, true);
      assertMatch(body.taskId, /^[0-9a-f-]{36}$/i);
      assertMatch(body.messageId, /^[0-9a-f-]{36}$/i);
      assertEquals(body.taskStatusPath, `/ingress/tasks/${body.taskId}`);
      const observed = observedMessages.at(-1);
      if (!observed) {
        throw new Error("WebhookChannel did not forward the inbound message");
      }
      assertEquals(observed.id, body.messageId);
      assertEquals(observed.metadata?.taskId, body.taskId);
      assertEquals(observed.metadata?.agentId, "agent-alpha");
    } finally {
      await channel.stop();
    }
  },
  ...testOpts,
});
