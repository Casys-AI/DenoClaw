import type { AnalyticsStore } from "../../db/analytics.ts";
import { getConfiguredAnalyticsStore } from "../../db/analytics.ts";
import {
  scheduleAnalyticsWrite,
} from "../../db/analytics_async.ts";
import type { AnalyticsWriteScheduler } from "../../db/analytics_async.ts";
import type { TaskState } from "../../messaging/a2a/types.ts";

export interface RecordTaskSubmissionHookInput {
  analytics?: AnalyticsStore | null;
  writeScheduler?: AnalyticsWriteScheduler;
  taskId: string;
  contextId?: string;
  fromAgent: string;
  targetAgent: string;
  submittedAt: Date;
}

export interface RecordTaskResultHookInput {
  analytics?: AnalyticsStore | null;
  writeScheduler?: AnalyticsWriteScheduler;
  taskId: string;
  contextId?: string;
  fromAgent: string;
  targetAgent: string;
  state: TaskState;
  changedAt: Date;
}

export function recordTaskSubmission(input: RecordTaskSubmissionHookInput): void {
  const analytics = input.analytics ?? getConfiguredAnalyticsStore();
  if (!analytics) return;

  scheduleWrite(input, "record task submission", () => analytics.recordTaskSubmission({
    taskId: input.taskId,
    contextId: input.contextId,
    fromAgent: input.fromAgent,
    targetAgent: input.targetAgent,
    submittedAt: input.submittedAt,
  }));
}

export function recordTaskResult(input: RecordTaskResultHookInput): void {
  const analytics = input.analytics ?? getConfiguredAnalyticsStore();
  if (!analytics) return;

  scheduleWrite(input, "record task result", () => analytics.recordTaskResult({
    taskId: input.taskId,
    contextId: input.contextId,
    fromAgent: input.fromAgent,
    targetAgent: input.targetAgent,
    state: input.state,
    changedAt: input.changedAt,
  }));
}

function scheduleWrite(
  input: {
    writeScheduler?: AnalyticsWriteScheduler;
  },
  operation: string,
  write: () => Promise<void>,
): void {
  if (input.writeScheduler) {
    input.writeScheduler.schedule(operation, write);
    return;
  }
  scheduleAnalyticsWrite(operation, write);
}
