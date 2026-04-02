import { assertEquals } from "@std/assert";
import { AnalyticsWriteScheduler } from "../../db/analytics_async.ts";
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
import type { SessionState } from "../middleware.ts";
import { analyticsMiddleware } from "./analytics.ts";

class RecordingAnalyticsStore implements AnalyticsStore {
  llmCalls: RecordLlmCallInput[] = [];
  toolExecutions: RecordToolExecutionInput[] = [];
  conversations: RecordConversationInput[] = [];
  taskSubmissions: RecordTaskSubmissionInput[] = [];
  taskResults: RecordTaskResultInput[] = [];

  recordLlmCall(input: RecordLlmCallInput): Promise<void> {
    this.llmCalls.push(input);
    return Promise.resolve();
  }

  recordToolExecution(input: RecordToolExecutionInput): Promise<void> {
    this.toolExecutions.push(input);
    return Promise.resolve();
  }

  recordConversation(input: RecordConversationInput): Promise<void> {
    this.conversations.push(input);
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

function makeSession(): SessionState {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    memoryTopics: [],
    memoryFiles: [],
  };
}

Deno.test("analyticsMiddleware records LLM calls and assistant conversation", async () => {
  const analytics = new RecordingAnalyticsStore();
  const times = [100, 145];
  const mw = analyticsMiddleware({
    analytics,
    now: () => times.shift() ?? 145,
  });

  await mw({
    event: {
      eventId: 1,
      timestamp: 1_700_000_000_000,
      iterationId: 1,
      type: "llm_request",
      messages: [],
      tools: [],
      config: { model: "openai/gpt-5.4" },
    },
    session: makeSession(),
  }, () => Promise.resolve({ type: "llm", content: "ok" }));

  await mw({
    event: {
      eventId: 2,
      timestamp: 1_700_000_000_050,
      iterationId: 1,
      type: "llm_response",
      content: "hello world",
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    },
    session: makeSession(),
  }, () => Promise.resolve(undefined));

  assertEquals(analytics.llmCalls.length, 1);
  assertEquals(analytics.llmCalls[0], {
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    model: "openai/gpt-5.4",
    provider: "openai",
    promptTokens: 11,
    completionTokens: 7,
    latencyMs: 45,
    createdAt: new Date(1_700_000_000_050),
  });
  assertEquals(analytics.conversations.length, 1);
  assertEquals(analytics.conversations[0], {
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    role: "assistant",
    content: "hello world",
    createdAt: new Date(1_700_000_000_050),
  });
});

Deno.test("analyticsMiddleware records tool executions and tool conversation", async () => {
  const analytics = new RecordingAnalyticsStore();
  const times = [200, 260];
  const mw = analyticsMiddleware({
    analytics,
    now: () => times.shift() ?? 260,
  });

  await mw({
    event: {
      eventId: 3,
      timestamp: 1_700_000_000_100,
      iterationId: 1,
      type: "tool_call",
      callId: "call-1",
      name: "shell",
      arguments: { command: "ls" },
    },
    session: makeSession(),
  }, () => Promise.resolve({ type: "tool", result: { success: false, output: "", error: { code: "DENIED", recovery: "check policy" } } }));

  await mw({
    event: {
      eventId: 4,
      timestamp: 1_700_000_000_150,
      iterationId: 1,
      type: "tool_result",
      callId: "call-1",
      name: "shell",
      arguments: { command: "ls" },
      result: {
        success: false,
        output: "",
        error: { code: "DENIED", recovery: "check policy" },
      },
    },
    session: makeSession(),
  }, () => Promise.resolve(undefined));

  assertEquals(analytics.toolExecutions.length, 1);
  assertEquals(analytics.toolExecutions[0], {
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    toolName: "shell",
    success: false,
    durationMs: 60,
    errorCode: "DENIED",
    createdAt: new Date(1_700_000_000_150),
  });
  assertEquals(analytics.conversations[0], {
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    role: "tool",
    content: "Error [DENIED]: undefined\nRecovery: check policy",
    toolName: "shell",
    toolCallId: "call-1",
    createdAt: new Date(1_700_000_000_150),
  });
});

Deno.test("analyticsMiddleware falls back to unknown provider for bare model names", async () => {
  const analytics = new RecordingAnalyticsStore();
  const mw = analyticsMiddleware({
    analytics,
    now: () => 100,
  });

  await mw({
    event: {
      eventId: 1,
      timestamp: 1_700_000_000_000,
      iterationId: 1,
      type: "llm_request",
      messages: [],
      tools: [],
      config: { model: "gpt-5.4" },
    },
    session: makeSession(),
  }, () => Promise.resolve({ type: "llm", content: "ok" }));

  await mw({
    event: {
      eventId: 2,
      timestamp: 1_700_000_000_050,
      iterationId: 1,
      type: "llm_response",
      content: "hello world",
    },
    session: makeSession(),
  }, () => Promise.resolve(undefined));

  assertEquals(analytics.llmCalls[0]?.provider, "unknown");
});

Deno.test("analyticsMiddleware does not crash and disables async writes after repeated failures", async () => {
  let attempts = 0;
  const analytics: AnalyticsStore = {
    recordLlmCall(_input) {
      attempts += 1;
      return Promise.reject(new Error("db down"));
    },
    recordToolExecution(_input) {
      attempts += 1;
      return Promise.reject(new Error("db down"));
    },
    recordConversation(_input) {
      attempts += 1;
      return Promise.reject(new Error("db down"));
    },
    recordTaskSubmission(_input) {
      attempts += 1;
      return Promise.reject(new Error("db down"));
    },
    recordTaskResult(_input) {
      attempts += 1;
      return Promise.reject(new Error("db down"));
    },
    listToolStats(_query) {
      return Promise.resolve([]);
    },
    listDailyMetrics(_query) {
      return Promise.resolve([]);
    },
    listLlmCalls(_query) {
      return Promise.resolve([]);
    },
    aggregateDailyMetrics(_input) {
      return Promise.resolve();
    },
  };
  const writeScheduler = new AnalyticsWriteScheduler(2);
  const mw = analyticsMiddleware({
    analytics,
    now: () => 100,
    writeScheduler,
  });

  await mw({
    event: {
      eventId: 1,
      timestamp: 1_700_000_000_000,
      iterationId: 1,
      type: "llm_response",
      content: "hello world",
    },
    session: makeSession(),
  }, () => Promise.resolve(undefined));

  await Promise.resolve();
  await Promise.resolve();

  await mw({
    event: {
      eventId: 2,
      timestamp: 1_700_000_000_050,
      iterationId: 1,
      type: "llm_response",
      content: "second attempt should be skipped",
    },
    session: makeSession(),
  }, () => Promise.resolve(undefined));

  await Promise.resolve();
  await Promise.resolve();

  assertEquals(attempts, 2);
});
