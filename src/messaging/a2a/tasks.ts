import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { log } from "../../shared/log.ts";
import {
  appendArtifactToTask,
  appendMessageToTask,
  createCanonicalTask,
  isTerminalTaskState,
  transitionTask,
} from "./internal_contract.ts";

/**
 * KV-backed Task store for A2A protocol.
 * Manages task lifecycle via the canonical internal A2A contract helpers.
 */
export class TaskStore {
  static readonly DEFAULT_CONFLICT_RETRIES = 5;

  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;
  private readonly maxConflictRetries: number;

  constructor(kv?: Deno.Kv, maxConflictRetries = TaskStore.DEFAULT_CONFLICT_RETRIES) {
    this.kv = kv ?? null;
    this.ownsKv = !kv;
    this.maxConflictRetries = maxConflictRetries;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  async create(
    taskId: string,
    message: A2AMessage,
    contextId?: string,
  ): Promise<Task> {
    const kv = await this.getKv();

    const task = createCanonicalTask({
      id: taskId,
      message,
      contextId,
    });

    await kv.set(["a2a_tasks", taskId], task);
    log.debug(`A2A Task created: ${taskId}`);
    return task;
  }

  async get(taskId: string): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    return entry.value;
  }

  async updateStatus(
    taskId: string,
    state: TaskState,
    message?: A2AMessage,
  ): Promise<Task | null> {
    const nextTask = await this.updateTaskWithRetry(taskId, (task) => {
      if (isTerminalTaskState(task.status.state)) {
        log.warn(
          `A2A Task ${taskId} is in terminal state ${task.status.state}, cannot change to ${state}`,
        );
        return task;
      }

      return applyStatusTransition(task, state, message);
    });
    if (!nextTask) return null;

    log.debug(`A2A Task ${taskId} → ${state}`);
    return nextTask;
  }

  async addArtifact(taskId: string, artifact: Artifact): Promise<Task | null> {
    return await this.updateTaskWithRetry(taskId, (task) =>
      appendArtifactToTask(task, artifact)
    );
  }

  async addMessage(taskId: string, message: A2AMessage): Promise<Task | null> {
    return await this.updateTaskWithRetry(taskId, (task) =>
      appendMessageToTask(task, message)
    );
  }

  async cancel(taskId: string): Promise<Task | null> {
    return await this.updateStatus(taskId, "CANCELED");
  }

  private async updateTaskWithRetry(
    taskId: string,
    mutateTask: (task: Task) => Task,
  ): Promise<Task | null> {
    const kv = await this.getKv();
    const key: Deno.KvKey = ["a2a_tasks", taskId];

    for (let attempt = 0; attempt < this.maxConflictRetries; attempt++) {
      const entry = await kv.get<Task>(key);
      if (!entry.value) return null;

      const nextTask = mutateTask(entry.value);
      const result = await kv.atomic()
        .check(entry)
        .set(key, nextTask)
        .commit();
      if (result.ok) return nextTask;

      await waitForRetry(attempt);
    }

    log.warn(
      `A2A Task ${taskId} update conflicted after ${this.maxConflictRetries} attempts`,
    );
    return await this.get(taskId);
  }

  async listByContext(contextId: string): Promise<Task[]> {
    const kv = await this.getKv();
    const tasks: Task[] = [];
    for await (const entry of kv.list<Task>({ prefix: ["a2a_tasks"] })) {
      if (entry.value?.contextId === contextId) {
        tasks.push(entry.value);
      }
    }
    return tasks;
  }

  close(): void {
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
  }
}

function applyStatusTransition(
  task: Task,
  state: TaskState,
  message?: A2AMessage,
): Task {
  const transitionedTask = transitionTask(task, state, { message });
  return message ? appendMessageToTask(transitionedTask, message) : transitionedTask;
}

async function waitForRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(10 * 2 ** attempt, 100);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
