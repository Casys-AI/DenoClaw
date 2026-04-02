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
import {
  recordTaskResult,
  recordTaskSubmission,
} from "./analytics_hooks.ts";

class RecordingAnalyticsStore implements AnalyticsStore {
  taskSubmissions: RecordTaskSubmissionInput[] = [];
  taskResults: RecordTaskResultInput[] = [];

  recordLlmCall(_input: RecordLlmCallInput): Promise<void> {
    return Promise.resolve();
  }

  recordToolExecution(_input: RecordToolExecutionInput): Promise<void> {
    return Promise.resolve();
  }

  recordConversation(_input: RecordConversationInput): Promise<void> {
    return Promise.resolve();
  }

  recordTaskSubmission(input: RecordTaskSubmissionInput): Promise<void> {
    this.taskSubmissions.push(input);
    return Promise.resolve();
  }

  recordTaskResult(input: RecordTaskResultInput): Promise<void> {
    this.taskResults.push(input);
    return Promise.resolve();
  }

  listToolStats(_query: ToolStatsQuery): Promise<ToolStatsEntry[]> {
    return Promise.resolve([]);
  }

  listDailyMetrics(_query: DailyMetricsQuery): Promise<DailyMetricsEntry[]> {
    return Promise.resolve([]);
  }

  listLlmCalls(_query: LlmCallsQuery): Promise<HistoricalLlmCallEntry[]> {
    return Promise.resolve([]);
  }

  aggregateDailyMetrics(_input: AggregateDailyMetricsInput): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("recordTaskSubmission forwards broker task lifecycle data", async () => {
  const analytics = new RecordingAnalyticsStore();
  const submittedAt = new Date("2026-04-02T10:00:00.000Z");

  recordTaskSubmission({
    analytics,
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    submittedAt,
  });
  await Promise.resolve();

  assertEquals(analytics.taskSubmissions, [{
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    submittedAt,
  }]);
});

Deno.test("recordTaskResult forwards broker task terminal state", async () => {
  const analytics = new RecordingAnalyticsStore();
  const changedAt = new Date("2026-04-02T10:05:00.000Z");

  recordTaskResult({
    analytics,
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    state: "COMPLETED",
    changedAt,
  });
  await Promise.resolve();

  assertEquals(analytics.taskResults, [{
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    state: "COMPLETED",
    changedAt,
  }]);
});

Deno.test("recordTaskSubmission and recordTaskResult are no-ops when analytics is disabled", () => {
  recordTaskSubmission({
    analytics: null,
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    submittedAt: new Date("2026-04-02T10:00:00.000Z"),
  });

  recordTaskResult({
    analytics: null,
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    state: "FAILED",
    changedAt: new Date("2026-04-02T10:05:00.000Z"),
  });
});
