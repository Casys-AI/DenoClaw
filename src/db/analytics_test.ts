import { assertEquals, assertRejects } from "@std/assert";
import type { RawDbClient } from "./client.ts";
import { PrismaAnalyticsStore } from "./analytics.ts";
import { DenoClawError } from "../shared/errors.ts";

function createFakeDb(overrides: Partial<RawDbClient> = {}): RawDbClient {
  return {
    llmCall: {
      create: () => Promise.resolve({}),
      findMany: () => Promise.resolve([]),
      aggregate: () => Promise.resolve({ _sum: {} }),
      count: () => Promise.resolve(0),
      ...(overrides.llmCall ?? {}),
    },
    toolExecution: {
      create: () => Promise.resolve({}),
      findMany: () => Promise.resolve([]),
      groupBy: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
      ...(overrides.toolExecution ?? {}),
    },
    conversation: {
      create: () => Promise.resolve({}),
      ...(overrides.conversation ?? {}),
    },
    agentTask: {
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      upsert: () => Promise.resolve({}),
      count: () => Promise.resolve(0),
      findMany: () => Promise.resolve([]),
      ...(overrides.agentTask ?? {}),
    },
    dailyMetrics: {
      findMany: () => Promise.resolve([]),
      upsert: () => Promise.resolve({}),
      ...(overrides.dailyMetrics ?? {}),
    },
    $disconnect: () => Promise.resolve(),
  };
}

Deno.test("PrismaAnalyticsStore recordTaskResult upserts missing task rows", async () => {
  let receivedArgs: Record<string, unknown> | undefined;
  const db = createFakeDb({
    agentTask: {
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      upsert: (args) => {
        receivedArgs = args;
        return Promise.resolve({});
      },
      count: () => Promise.resolve(0),
      findMany: () => Promise.resolve([]),
    },
  });
  const store = new PrismaAnalyticsStore(() => Promise.resolve(db));
  const changedAt = new Date("2026-04-02T10:05:00.000Z");

  await store.recordTaskResult({
    taskId: "task-1",
    contextId: "ctx-1",
    fromAgent: "agent-alpha",
    targetAgent: "agent-beta",
    state: "COMPLETED",
    changedAt,
  });

  assertEquals(receivedArgs, {
    where: { id: "task-1" },
    create: {
      id: "task-1",
      contextId: "ctx-1",
      fromAgent: "agent-alpha",
      targetAgent: "agent-beta",
      state: "COMPLETED",
      createdAt: changedAt,
      completedAt: changedAt,
    },
    update: {
      contextId: "ctx-1",
      fromAgent: "agent-alpha",
      targetAgent: "agent-beta",
      state: "COMPLETED",
      completedAt: changedAt,
    },
  });
});

Deno.test("PrismaAnalyticsStore aggregateDailyMetrics isolates per-agent failures", async () => {
  const upsertedAgents: string[] = [];
  const db = createFakeDb({
    llmCall: {
      create: () => Promise.resolve({}),
      findMany: () => Promise.resolve([{ agentId: "agent-a" }]),
      aggregate: () =>
        Promise.resolve({
          _sum: {
            promptTokens: 10,
            completionTokens: 5,
            latencyMs: 80,
          },
        }),
      count: () => Promise.resolve(1),
    },
    toolExecution: {
      create: () => Promise.resolve({}),
      findMany: () => Promise.resolve([{ agentId: "agent-b" }]),
      groupBy: () => Promise.resolve([]),
      count: (args) => {
        const where = (args as { where?: { success?: boolean } }).where;
        return Promise.resolve(where?.success === false ? 1 : 2);
      },
    },
    agentTask: {
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      upsert: () => Promise.resolve({}),
      count: () => Promise.resolve(1),
      findMany: () => Promise.resolve([]),
    },
    dailyMetrics: {
      findMany: () => Promise.resolve([]),
      upsert: (args) => {
        const agentId = (
          args as { where: { agentId_date: { agentId: string } } }
        ).where.agentId_date.agentId;
        if (agentId === "agent-a") {
          return Promise.reject(new Error("db down"));
        }
        upsertedAgents.push(agentId);
        return Promise.resolve({});
      },
    },
  });
  const store = new PrismaAnalyticsStore(() => Promise.resolve(db));

  await assertRejects(
    () =>
      store.aggregateDailyMetrics({
        date: new Date("2026-04-02T12:00:00.000Z"),
      }),
    DenoClawError,
    "ANALYTICS_AGGREGATION_PARTIAL_FAILURE",
  );

  assertEquals(upsertedAgents, ["agent-b"]);
});
