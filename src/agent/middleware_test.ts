import { assertEquals } from "@std/assert";
import { MiddlewarePipeline } from "./middleware.ts";
import type { SessionState } from "./middleware.ts";
import type { LlmRequestEvent } from "./events.ts";

function makeEvent(): LlmRequestEvent {
  return {
    eventId: 0, timestamp: Date.now(), iterationId: 1,
    type: "llm_request", messages: [], tools: [], config: { model: "test" },
  };
}

function makeSession(): SessionState {
  return {
    agentId: "agent-1", sessionId: "sess-1",
    memoryTopics: [], memoryFiles: [],
  };
}

Deno.test("empty pipeline returns undefined", async () => {
  const pipeline = new MiddlewarePipeline();
  const result = await pipeline.execute(makeEvent(), makeSession());
  assertEquals(result, undefined);
});

Deno.test("middleware can resolve an event", async () => {
  const pipeline = new MiddlewarePipeline();
  pipeline.use((_ctx, _next) => {
    return Promise.resolve({ type: "llm" as const, content: "hello", toolCalls: [] });
  });
  const result = await pipeline.execute(makeEvent(), makeSession());
  assertEquals(result?.type, "llm");
});

Deno.test("middleware chain executes in order (onion model)", async () => {
  const order: string[] = [];
  const pipeline = new MiddlewarePipeline();
  pipeline.use(async (_ctx, next) => {
    order.push("A-before");
    const res = await next();
    order.push("A-after");
    return res;
  });
  pipeline.use(async (_ctx, next) => {
    order.push("B-before");
    const res = await next();
    order.push("B-after");
    return res;
  });
  pipeline.use((_ctx, _next) => {
    order.push("C-resolve");
    return Promise.resolve({ type: "llm" as const, content: "ok", toolCalls: [] });
  });
  await pipeline.execute(makeEvent(), makeSession());
  assertEquals(order, ["A-before", "B-before", "C-resolve", "B-after", "A-after"]);
});

Deno.test("middleware receives event and session in context", async () => {
  const pipeline = new MiddlewarePipeline();
  let capturedEvent: unknown;
  let capturedSession: unknown;
  pipeline.use((ctx, _next) => {
    capturedEvent = ctx.event;
    capturedSession = ctx.session;
    return Promise.resolve(undefined);
  });
  const event = makeEvent();
  const session = makeSession();
  await pipeline.execute(event, session);
  assertEquals(capturedEvent, event);
  assertEquals(capturedSession, session);
});
