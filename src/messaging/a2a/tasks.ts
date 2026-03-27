import type { A2AMessage, Artifact, Task, TaskState } from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import { log } from "../../shared/log.ts";

/**
 * KV-backed Task store for A2A protocol.
 * Manages task lifecycle: SUBMITTED → WORKING → COMPLETED/FAILED.
 */
export class TaskStore {
  private kv: Deno.Kv | null = null;

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  async create(taskId: string, message: A2AMessage, contextId?: string): Promise<Task> {
    const kv = await this.getKv();

    const task: Task = {
      id: taskId,
      contextId,
      status: { state: "SUBMITTED", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [message],
    };

    await kv.set(["a2a_tasks", taskId], task);
    log.debug(`A2A Task créée : ${taskId}`);
    return task;
  }

  async get(taskId: string): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    return entry.value;
  }

  async updateStatus(taskId: string, state: TaskState, message?: A2AMessage): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const task = entry.value;

    // Can't change terminal states
    if (TERMINAL_STATES.includes(task.status.state)) {
      log.warn(`A2A Task ${taskId} is in terminal state ${task.status.state}, cannot change to ${state}`);
      return task;
    }

    task.status = {
      state,
      message,
      timestamp: new Date().toISOString(),
    };

    if (message) task.history.push(message);

    await kv.set(["a2a_tasks", taskId], task);
    log.debug(`A2A Task ${taskId} → ${state}`);
    return task;
  }

  async addArtifact(taskId: string, artifact: Artifact): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const task = entry.value;
    task.artifacts.push(artifact);
    await kv.set(["a2a_tasks", taskId], task);
    return task;
  }

  async addMessage(taskId: string, message: A2AMessage): Promise<Task | null> {
    const kv = await this.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return null;

    const task = entry.value;
    task.history.push(message);
    await kv.set(["a2a_tasks", taskId], task);
    return task;
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
    if (this.kv) { this.kv.close(); this.kv = null; }
  }
}
