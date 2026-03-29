import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { log } from "../../shared/log.ts";
import { TaskEntity } from "./task_entity.ts";

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

    const task = TaskEntity.createCanonical({
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
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const task = entry.value;

    if (TaskEntity.isTerminalState(task.status.state)) {
      log.warn(
        `A2A Task ${taskId} is in terminal state ${task.status.state}, cannot change to ${state}`,
      );
      return task;
    }

    let nextTask = new TaskEntity(task).transitionTo(state, { message }).task;
    if (message) nextTask = new TaskEntity(nextTask).appendMessage(message).task;

    await kv.set(["a2a_tasks", taskId], nextTask);
    log.debug(`A2A Task ${taskId} → ${state}`);
    return nextTask;
  }

  async addArtifact(taskId: string, artifact: Artifact): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const nextTask = new TaskEntity(entry.value).appendArtifact(artifact).task;
    await kv.set(["a2a_tasks", taskId], nextTask);
    return nextTask;
  }

  async addMessage(taskId: string, message: A2AMessage): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const nextTask = new TaskEntity(entry.value).appendMessage(message).task;
    await kv.set(["a2a_tasks", taskId], nextTask);
    return nextTask;
  }

  async cancel(taskId: string): Promise<Task | null> {
    return await this.updateStatus(taskId, "CANCELED");
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
