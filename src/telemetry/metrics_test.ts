import { assertEquals } from "@std/assert";
import { MetricsCollector } from "./metrics.ts";

async function createTestMetricsCollector(): Promise<{
  metrics: MetricsCollector;
  kvPath: string;
}> {
  const kvPath = await Deno.makeTempFile({ dir: "/tmp", suffix: ".db" });
  const kv = await Deno.openKv(kvPath);
  return {
    metrics: new MetricsCollector(kv),
    kvPath,
  };
}

Deno.test({
  name: "MetricsCollector aggregates agent and summary counters",
  async fn() {
    const { metrics, kvPath } = await createTestMetricsCollector();

    await metrics.recordLLMCall(
      "agent-alpha",
      "openai",
      { prompt: 12, completion: 8 },
      140,
    );
    await metrics.recordToolCall("agent-alpha", "shell", true, 25);
    await metrics.recordToolCall("agent-alpha", "shell", false, 75);
    await metrics.recordAgentMessage("agent-alpha", "agent-beta");

    const agent = await metrics.getAgentMetrics("agent-alpha");
    const summary = await metrics.getSummary();

    assertEquals(agent.llm.calls, 1);
    assertEquals(agent.llm.totalTokens, 20);
    assertEquals(agent.tools.calls, 2);
    assertEquals(agent.tools.successes, 1);
    assertEquals(agent.tools.failures, 1);
    assertEquals(agent.a2a.messagesSent, 1);
    assertEquals(agent.a2a.peersContacted, ["agent-beta"]);

    assertEquals(summary.totalAgents, 2);
    assertEquals(summary.totalLLMCalls, 1);
    assertEquals(summary.totalTokens, 20);
    assertEquals(summary.totalToolCalls, 2);
    assertEquals(summary.totalA2AMessages, 1);

    metrics.close();
    await Deno.remove(kvPath).catch(() => {});
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MetricsCollector exposes breakdown and hourly queries",
  async fn() {
    const { metrics, kvPath } = await createTestMetricsCollector();
    const now = new Date().toISOString();

    await metrics.recordLLMCall(
      "agent-alpha",
      "openai",
      { prompt: 3, completion: 2 },
      50,
    );
    await metrics.recordToolCall("agent-alpha", "read_file", true, 10);
    await metrics.recordAgentMessage("agent-alpha", "agent-beta");

    const toolBreakdown = await metrics.getToolBreakdown("agent-alpha");
    const hourlyMetrics = await metrics.getHourlyMetrics(
      "agent-alpha",
      now,
      now,
    );
    const hourlyA2A = await metrics.getHourlyA2A("agent-alpha", now, now);
    const frequency = await metrics.getA2AFrequencyMatrix(now, now);
    const hourlyToolUsage = await metrics.getHourlyToolUsage(
      "agent-alpha",
      now,
      now,
    );

    assertEquals(toolBreakdown, [{
      tool: "read_file",
      calls: 1,
      successes: 1,
      failures: 0,
      avgLatencyMs: 10,
    }]);
    assertEquals(hourlyMetrics.length, 1);
    assertEquals(hourlyMetrics[0]?.provider, "openai");
    assertEquals(hourlyMetrics[0]?.calls, 1);
    assertEquals(hourlyMetrics[0]?.tokens, 5);
    assertEquals(hourlyA2A.length, 1);
    assertEquals(hourlyA2A[0]?.sent, 1);
    assertEquals(frequency.length, 1);
    assertEquals(frequency[0]?.fromAgent, "agent-alpha");
    assertEquals(frequency[0]?.toAgent, "agent-beta");
    assertEquals(frequency[0]?.totalCalls, 1);
    assertEquals(hourlyToolUsage, [{
      hour: now.slice(0, 13),
      tool: "read_file",
      calls: 1,
    }]);

    metrics.close();
    await Deno.remove(kvPath).catch(() => {});
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
