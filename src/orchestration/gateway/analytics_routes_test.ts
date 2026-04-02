import { assertEquals } from "@std/assert";
import type {
  AnalyticsStore,
  AggregateDailyMetricsInput,
  DailyMetricsEntry,
  HistoricalLlmCallEntry,
  RecordConversationInput,
  RecordLlmCallInput,
  RecordTaskResultInput,
  RecordTaskSubmissionInput,
  RecordToolExecutionInput,
  LlmCallsQuery,
  DailyMetricsQuery,
  ToolStatsQuery,
  ToolStatsEntry,
} from "../../db/analytics.ts";
import { handleGatewayAnalyticsRoute } from "./analytics_routes.ts";

class FakeAnalyticsStore implements AnalyticsStore {
  recordLlmCall(_input: RecordLlmCallInput): Promise<void> {
    return Promise.resolve();
  }

  recordToolExecution(_input: RecordToolExecutionInput): Promise<void> {
    return Promise.resolve();
  }

  recordConversation(_input: RecordConversationInput): Promise<void> {
    return Promise.resolve();
  }

  recordTaskSubmission(_input: RecordTaskSubmissionInput): Promise<void> {
    return Promise.resolve();
  }

  recordTaskResult(_input: RecordTaskResultInput): Promise<void> {
    return Promise.resolve();
  }

  listToolStats(_query: ToolStatsQuery): Promise<ToolStatsEntry[]> {
    return Promise.resolve([{
      name: "shell",
      calls: 3,
      successes: 2,
      failures: 1,
      avgLatencyMs: 120,
    }]);
  }

  listDailyMetrics(_query: DailyMetricsQuery): Promise<DailyMetricsEntry[]> {
    return Promise.resolve([{
      date: "2026-04-01",
      totalLlmCalls: 4,
      totalTokens: 400,
      totalToolCalls: 2,
      totalTasks: 1,
      errorCount: 1,
      avgLatencyMs: 95,
    }]);
  }

  listLlmCalls(_query: LlmCallsQuery): Promise<HistoricalLlmCallEntry[]> {
    return Promise.resolve([{
      model: "openai/gpt-5.4",
      provider: "openai",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 80,
      createdAt: "2026-04-02T10:00:00.000Z",
      sessionId: "session-1",
      taskId: "task-1",
    }]);
  }

  aggregateDailyMetrics(_input: AggregateDailyMetricsInput): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("handleGatewayAnalyticsRoute returns tool stats", async () => {
  const response = await handleGatewayAnalyticsRoute(
    { analytics: new FakeAnalyticsStore() },
    new URL("http://localhost/stats/tools?agent=agent-alpha"),
  );

  assertEquals(response?.status, 200);
  assertEquals(await response?.json(), {
    tools: [{
      name: "shell",
      calls: 3,
      successes: 2,
      failures: 1,
      avgLatencyMs: 120,
    }],
  });
});

Deno.test("handleGatewayAnalyticsRoute validates history date range", async () => {
  const response = await handleGatewayAnalyticsRoute(
    { analytics: new FakeAnalyticsStore() },
    new URL("http://localhost/stats/history?agent=agent-alpha&from=2026-04-01&to=bad"),
  );

  assertEquals(response?.status, 400);
  assertEquals(await response?.json(), {
    error: {
      code: "INVALID_INPUT",
      recovery: "Use YYYY-MM-DD for from/to analytics dates",
    },
  });
});

Deno.test("handleGatewayAnalyticsRoute returns history metrics", async () => {
  const response = await handleGatewayAnalyticsRoute(
    { analytics: new FakeAnalyticsStore() },
    new URL("http://localhost/stats/history?agent=agent-alpha&from=2026-04-01&to=2026-04-02"),
  );

  assertEquals(response?.status, 200);
  assertEquals(await response?.json(), {
    metrics: [{
      date: "2026-04-01",
      totalLlmCalls: 4,
      totalTokens: 400,
      totalToolCalls: 2,
      totalTasks: 1,
      errorCount: 1,
      avgLatencyMs: 95,
    }],
  });
});

Deno.test("handleGatewayAnalyticsRoute distinguishes analytics not configured", async () => {
  const response = await handleGatewayAnalyticsRoute(
    { analytics: null },
    new URL("http://localhost/stats/tools?agent=agent-alpha"),
  );

  assertEquals(response?.status, 501);
  assertEquals(await response?.json(), {
    error: {
      code: "ANALYTICS_NOT_CONFIGURED",
      recovery:
        "Set DATABASE_URL and run `deno task db:generate` to enable persistent analytics",
    },
  });
});

Deno.test("handleGatewayAnalyticsRoute logs query failures and returns structured 503", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    class FailingAnalyticsStore extends FakeAnalyticsStore {
      override listToolStats(_query: ToolStatsQuery): Promise<ToolStatsEntry[]> {
        return Promise.reject(new Error("query failed"));
      }
    }

    const response = await handleGatewayAnalyticsRoute(
      {
        analytics: new FailingAnalyticsStore(),
      },
      new URL("http://localhost/stats/tools?agent=agent-alpha"),
    );

    assertEquals(response?.status, 503);
    assertEquals(await response?.json(), {
      error: {
        code: "ANALYTICS_QUERY_FAILED",
        context: {
          message: "query failed",
        },
        recovery:
          "Retry the request or inspect the broker logs for the underlying datastore failure",
      },
    });
    assertEquals(errors.length, 1);
  } finally {
    console.error = originalError;
  }
});

Deno.test("handleGatewayAnalyticsRoute returns historical llm calls", async () => {
  const response = await handleGatewayAnalyticsRoute(
    { analytics: new FakeAnalyticsStore() },
    new URL("http://localhost/agents/agent-alpha/traces?limit=25"),
  );

  assertEquals(response?.status, 200);
  assertEquals(await response?.json(), {
    calls: [{
      model: "openai/gpt-5.4",
      provider: "openai",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 80,
      createdAt: "2026-04-02T10:00:00.000Z",
      sessionId: "session-1",
      taskId: "task-1",
    }],
  });
});

Deno.test("handleGatewayAnalyticsRoute rejects non-positive trace limits", async () => {
  const response = await handleGatewayAnalyticsRoute(
    { analytics: new FakeAnalyticsStore() },
    new URL("http://localhost/agents/agent-alpha/traces?limit=0"),
  );

  assertEquals(response?.status, 400);
  assertEquals(await response?.json(), {
    error: {
      code: "INVALID_INPUT",
      recovery: "Provide ?limit=<1-200> when querying historical traces",
    },
  });
});
