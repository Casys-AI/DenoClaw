import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { log } from "../../shared/log.ts";
import {
  appendArtifactToTask,
  createCanonicalTask,
  isTerminalTaskState,
  transitionTask,
} from "./internal_contract.ts";

/**
 * KV-backed Task store for A2A protocol.
 * Manages task lifecycle via the canonical internal A2A contract helpers.
 */
export class TaskStore {
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;

  constructor(kv?: Deno.Kv) {
    this.kv = kv ?? null;
    this.ownsKv = !kv;
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
      initialMessage: message,
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
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const task = entry.value;

    if (isTerminalTaskState(task.status.state)) {
      log.warn(
        `A2A Task ${taskId} is in terminal state ${task.status.state}, cannot change to ${state}`,
      );
      return task;
    }

    const nextTask = transitionTask(task, state, { statusMessage: message });
    if (message) nextTask.history = [...nextTask.history, message];

    await kv.set(["a2a_tasks", taskId], nextTask);
    log.debug(`A2A Task ${taskId} → ${state}`);
    return nextTask;
  }

  async appendHistoryMessage(
    taskId: string,
    message: A2AMessage,
  ): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const nextTask: Task = {
      ...entry.value,
      history: [...entry.value.history, message],
    };
    await kv.set(["a2a_tasks", taskId], nextTask);
    return nextTask;
  }

  async startWorking(taskId: string): Promise<Task | null> {
    return await this.updateStatus(taskId, "WORKING");
  }

  async completeTask(taskId: string, message: A2AMessage): Promise<Task | null> {
    return await this.updateStatus(taskId, "COMPLETED", message);
  }

  async failTask(taskId: string, message: A2AMessage): Promise<Task | null> {
    return await this.updateStatus(taskId, "FAILED", message);
  }

  async addArtifact(taskId: string, artifact: Artifact): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const nextTask = appendArtifactToTask(entry.value, artifact);
    await kv.set(["a2a_tasks", taskId], nextTask);
    return nextTask;
  }

  async addMessage(taskId: string, message: A2AMessage): Promise<Task | null> {
    return await this.appendHistoryMessage(taskId, message);
  }

  async cancel(taskId: string): Promise<Task | null> {
    return await this.updateStatus(taskId, "CANCELED");
  }

  async cancelTask(taskId: string): Promise<Task | null> {
    return await this.cancel(taskId);
  }

  canAcceptUpdates(task: Task): boolean {
    return !isTerminalTaskState(task.status.state);
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
