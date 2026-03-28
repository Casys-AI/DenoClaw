import { assertEquals, assertExists } from "@std/assert";
import {
  getTrace,
  getTraceSpans,
  resolveTraceCorrelationIds,
  TraceWriter,
} from "./traces.ts";

Deno.test("resolveTraceCorrelationIds falls back contextId to taskId or sessionId", () => {
  assertEquals(resolveTraceCorrelationIds("session-1", {}), {
    contextId: "session-1",
  });
  assertEquals(resolveTraceCorrelationIds("session-1", { taskId: "task-1" }), {
    taskId: "task-1",
    contextId: "task-1",
  });
  assertEquals(
    resolveTraceCorrelationIds("session-1", {
      taskId: "task-1",
      contextId: "ctx-1",
    }),
    {
      taskId: "task-1",
      contextId: "ctx-1",
    },
  );
});

Deno.test(async function traceWriter_persists_canonical_task_and_context_ids() {
  const kvPath = await Deno.makeTempFile({ suffix: ".db" });
  const kv = await Deno.openKv(kvPath);

  try {
    const writer = new TraceWriter(kv, 60_000);
    const traceId = await writer.startTrace("agent-alpha", "session-1", {
      taskId: "task-123",
      contextId: "ctx-root",
    });

    const spanId = await writer.writeIterationSpan(
      traceId,
      "agent-alpha",
      1,
      undefined,
      { taskId: "task-123", contextId: "ctx-root" },
    );
    await writer.endSpan(traceId, spanId, 12);

    const trace = await getTrace(kv, traceId);
    assertExists(trace);
    assertEquals(trace.taskId, "task-123");
    assertEquals(trace.contextId, "ctx-root");

    const spans = await getTraceSpans(kv, traceId);
    assertEquals(spans.length, 1);
    assertEquals(spans[0].taskId, "task-123");
    assertEquals(spans[0].contextId, "ctx-root");
    assertEquals(spans[0].data.type, "iteration");
  } finally {
    kv.close();
    await Deno.remove(kvPath);
  }
});
