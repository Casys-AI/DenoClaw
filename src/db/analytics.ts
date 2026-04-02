import type { RawDbClient } from "./client.ts";
import { getDb, isAnalyticsConfigured } from "./client.ts";
import { TERMINAL_STATES, type TaskState } from "../messaging/a2a/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

export interface RecordLlmCallInput {
  agentId: string;
  sessionId?: string;
  taskId?: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: Date;
}

export interface RecordToolExecutionInput {
  agentId: string;
  sessionId?: string;
  taskId?: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  errorCode?: string;
  createdAt: Date;
}

export interface RecordConversationInput {
  agentId: string;
  sessionId: string;
  taskId?: string;
  role: "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  createdAt: Date;
}

export interface RecordTaskSubmissionInput {
  taskId: string;
  contextId?: string;
  fromAgent: string;
  targetAgent: string;
  submittedAt: Date;
}

export interface RecordTaskResultInput {
  taskId: string;
  contextId?: string;
  fromAgent: string;
  targetAgent: string;
  state: TaskState;
  changedAt: Date;
}

export interface ToolStatsQuery {
  agentId: string;
}

export interface DailyMetricsQuery {
  agentId: string;
  from: Date;
  to: Date;
}

export interface LlmCallsQuery {
  agentId: string;
  limit: number;
}

export interface AggregateDailyMetricsInput {
  date: Date;
}

export interface ToolStatsEntry {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
}

export interface DailyMetricsEntry {
  date: string;
  totalLlmCalls: number;
  totalTokens: number;
  totalToolCalls: number;
  totalTasks: number;
  errorCount: number;
  avgLatencyMs: number;
}

export interface HistoricalLlmCallEntry {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  createdAt: string;
  sessionId?: string;
  taskId?: string;
}

export interface AnalyticsStore {
  recordLlmCall(input: RecordLlmCallInput): Promise<void>;
  recordToolExecution(input: RecordToolExecutionInput): Promise<void>;
  recordConversation(input: RecordConversationInput): Promise<void>;
  recordTaskSubmission(input: RecordTaskSubmissionInput): Promise<void>;
  recordTaskResult(input: RecordTaskResultInput): Promise<void>;
  listToolStats(query: ToolStatsQuery): Promise<ToolStatsEntry[]>;
  listDailyMetrics(query: DailyMetricsQuery): Promise<DailyMetricsEntry[]>;
  listLlmCalls(query: LlmCallsQuery): Promise<HistoricalLlmCallEntry[]>;
  aggregateDailyMetrics(input: AggregateDailyMetricsInput): Promise<void>;
}

type ToolGroupRow = {
  toolName: string;
  success: boolean;
  _count?: { _all?: number } | number;
  _sum?: { durationMs?: number | null };
};

type AgentIdRow = { agentId?: string; targetAgent?: string };

type DailyMetricsRow = {
  date: Date;
  totalLlmCalls: number;
  totalTokens: number;
  totalToolCalls: number;
  totalTasks: number;
  errorCount: number;
  avgLatencyMs: number;
};

type LlmCallRow = {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: Date;
  sessionId?: string | null;
  taskId?: string | null;
};

export class PrismaAnalyticsStore implements AnalyticsStore {
  constructor(
    private readonly dbProvider: () => Promise<RawDbClient> = getDb,
  ) {}

  async recordLlmCall(input: RecordLlmCallInput): Promise<void> {
    const db = await this.dbProvider();
    await db.llmCall.create({
      data: {
        agentId: input.agentId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        model: input.model,
        provider: input.provider,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        latencyMs: input.latencyMs,
        createdAt: input.createdAt,
      },
    });
  }

  async recordToolExecution(input: RecordToolExecutionInput): Promise<void> {
    const db = await this.dbProvider();
    await db.toolExecution.create({
      data: {
        agentId: input.agentId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        toolName: input.toolName,
        success: input.success,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
        createdAt: input.createdAt,
      },
    });
  }

  async recordConversation(input: RecordConversationInput): Promise<void> {
    const db = await this.dbProvider();
    await db.conversation.create({
      data: {
        agentId: input.agentId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        role: input.role,
        content: input.content,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        createdAt: input.createdAt,
      },
    });
  }

  async recordTaskSubmission(input: RecordTaskSubmissionInput): Promise<void> {
    const db = await this.dbProvider();
    await db.agentTask.create({
      data: {
        id: input.taskId,
        contextId: input.contextId,
        fromAgent: input.fromAgent,
        targetAgent: input.targetAgent,
        state: "SUBMITTED",
        createdAt: input.submittedAt,
      },
    });
  }

  async recordTaskResult(input: RecordTaskResultInput): Promise<void> {
    const db = await this.dbProvider();
    await db.agentTask.upsert({
      where: { id: input.taskId },
      create: {
        id: input.taskId,
        contextId: input.contextId,
        fromAgent: input.fromAgent,
        targetAgent: input.targetAgent,
        state: input.state,
        createdAt: input.changedAt,
        ...(isTerminalAnalyticsTaskState(input.state)
          ? { completedAt: input.changedAt }
          : {}),
      },
      update: {
        contextId: input.contextId,
        fromAgent: input.fromAgent,
        targetAgent: input.targetAgent,
        state: input.state,
        ...(isTerminalAnalyticsTaskState(input.state)
          ? { completedAt: input.changedAt }
          : {}),
      },
    });
  }

  async listToolStats(query: ToolStatsQuery): Promise<ToolStatsEntry[]> {
    const db = await this.dbProvider();
    const rows = await db.toolExecution.groupBy({
      by: ["toolName", "success"],
      where: { agentId: query.agentId },
      _count: { _all: true },
      _sum: { durationMs: true },
    }) as ToolGroupRow[];

    const byTool = new Map<string, ToolStatsEntry & { totalDurationMs: number }>();
    for (const row of rows) {
      const key = row.toolName;
      const current = byTool.get(key) ?? {
        name: key,
        calls: 0,
        successes: 0,
        failures: 0,
        avgLatencyMs: 0,
        totalDurationMs: 0,
      };
      const count = readGroupCount(row._count);
      const totalDurationMs = row._sum?.durationMs ?? 0;
      current.calls += count;
      current.totalDurationMs += totalDurationMs;
      if (row.success) {
        current.successes += count;
      } else {
        current.failures += count;
      }
      current.avgLatencyMs = current.calls > 0
        ? Math.round(current.totalDurationMs / current.calls)
        : 0;
      byTool.set(key, current);
    }

    return [...byTool.values()]
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        calls: entry.calls,
        successes: entry.successes,
        failures: entry.failures,
        avgLatencyMs: entry.avgLatencyMs,
      }));
  }

  async listDailyMetrics(query: DailyMetricsQuery): Promise<DailyMetricsEntry[]> {
    const db = await this.dbProvider();
    const rows = await db.dailyMetrics.findMany({
      where: {
        agentId: query.agentId,
        date: { gte: query.from, lte: query.to },
      },
      orderBy: { date: "asc" },
    }) as DailyMetricsRow[];

    return rows.map((row) => ({
      date: formatDate(row.date),
      totalLlmCalls: row.totalLlmCalls,
      totalTokens: row.totalTokens,
      totalToolCalls: row.totalToolCalls,
      totalTasks: row.totalTasks,
      errorCount: row.errorCount,
      avgLatencyMs: row.avgLatencyMs,
    }));
  }

  async listLlmCalls(query: LlmCallsQuery): Promise<HistoricalLlmCallEntry[]> {
    const db = await this.dbProvider();
    const rows = await db.llmCall.findMany({
      where: { agentId: query.agentId },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    }) as LlmCallRow[];

    return rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.promptTokens + row.completionTokens,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      ...(row.taskId ? { taskId: row.taskId } : {}),
    }));
  }

  async aggregateDailyMetrics(input: AggregateDailyMetricsInput): Promise<void> {
    const db = await this.dbProvider();
    const from = startOfUtcDay(input.date);
    const to = addDays(from, 1);

    const [llmAgents, toolAgents, taskAgents] = await Promise.all([
      db.llmCall.findMany({
        where: { createdAt: { gte: from, lt: to } },
        distinct: ["agentId"],
        select: { agentId: true },
      }) as Promise<AgentIdRow[]>,
      db.toolExecution.findMany({
        where: { createdAt: { gte: from, lt: to } },
        distinct: ["agentId"],
        select: { agentId: true },
      }) as Promise<AgentIdRow[]>,
      db.agentTask.findMany({
        where: { createdAt: { gte: from, lt: to } },
        distinct: ["targetAgent"],
        select: { targetAgent: true },
      }) as Promise<AgentIdRow[]>,
    ]);

    const agentIds = new Set<string>();
    for (const row of llmAgents) {
      if (row.agentId) agentIds.add(row.agentId);
    }
    for (const row of toolAgents) {
      if (row.agentId) agentIds.add(row.agentId);
    }
    for (const row of taskAgents) {
      if (row.targetAgent) agentIds.add(row.targetAgent);
    }

    const failedAgentIds: string[] = [];
    for (const agentId of agentIds) {
      const llmWhere = { agentId, createdAt: { gte: from, lt: to } };
      const toolWhere = { agentId, createdAt: { gte: from, lt: to } };
      const taskWhere = { targetAgent: agentId, createdAt: { gte: from, lt: to } };

      try {
        const [llmCount, llmTotals, toolCount, taskCount, errorCount] =
          await Promise.all([
            db.llmCall.count({ where: llmWhere }),
            db.llmCall.aggregate({
              where: llmWhere,
              _sum: {
                promptTokens: true,
                completionTokens: true,
                latencyMs: true,
              },
            }) as Promise<Record<string, unknown>>,
            db.toolExecution.count({ where: toolWhere }),
            db.agentTask.count({ where: taskWhere }),
            db.toolExecution.count({
              where: { ...toolWhere, success: false },
            }),
          ]);

        const llmSums = readAggregateSums(llmTotals);
        await db.dailyMetrics.upsert({
          where: { agentId_date: { agentId, date: from } },
          create: {
            agentId,
            date: from,
            totalLlmCalls: llmCount,
            totalTokens: llmSums.promptTokens + llmSums.completionTokens,
            totalToolCalls: toolCount,
            totalTasks: taskCount,
            errorCount,
            avgLatencyMs: llmCount > 0
              ? Math.round(llmSums.latencyMs / llmCount)
              : 0,
          },
          update: {
            totalLlmCalls: llmCount,
            totalTokens: llmSums.promptTokens + llmSums.completionTokens,
            totalToolCalls: toolCount,
            totalTasks: taskCount,
            errorCount,
            avgLatencyMs: llmCount > 0
              ? Math.round(llmSums.latencyMs / llmCount)
              : 0,
          },
        });
      } catch (error) {
        failedAgentIds.push(agentId);
        log.error("analytics: failed to aggregate daily metrics for agent", {
          agentId,
          date: formatDate(from),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (failedAgentIds.length > 0) {
      throw new DenoClawError(
        "ANALYTICS_AGGREGATION_PARTIAL_FAILURE",
        { date: formatDate(from), agentIds: failedAgentIds },
        "Inspect the per-agent analytics aggregation logs and retry the job",
      );
    }
  }
}

let configuredAnalyticsStore: PrismaAnalyticsStore | null = null;

export function getConfiguredAnalyticsStore(): AnalyticsStore | null {
  if (!isAnalyticsConfigured()) return null;
  if (!configuredAnalyticsStore) {
    configuredAnalyticsStore = new PrismaAnalyticsStore();
  }
  return configuredAnalyticsStore;
}

function readGroupCount(value: { _all?: number } | number | undefined): number {
  if (typeof value === "number") return value;
  return value?._all ?? 0;
}

function readAggregateSums(value: Record<string, unknown>): {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
} {
  const raw = value._sum;
  if (!raw || typeof raw !== "object") {
    return { promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  }

  const sums = raw as Record<string, number | null | undefined>;
  return {
    promptTokens: sums.promptTokens ?? 0,
    completionTokens: sums.completionTokens ?? 0,
    latencyMs: sums.latencyMs ?? 0,
  };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isTerminalAnalyticsTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}
