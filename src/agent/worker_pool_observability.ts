import type { WorkerTaskObserveMessage } from "./worker_protocol.ts";

export class WorkerPoolObservability {
  private sharedKv: Deno.Kv | null = null;

  setSharedKv(kv: Deno.Kv): void {
    this.sharedKv = kv;
  }

  writeActiveTask(
    agentId: string,
    taskId: string,
    sessionId: string,
    traceId?: string,
    contextId?: string,
  ): void {
    if (!this.sharedKv) return;
    this.sharedKv.set(["agents", agentId, "active_task"], {
      taskId,
      sessionId,
      traceId,
      contextId,
      startedAt: new Date().toISOString(),
    }).catch(() => {/* best-effort */});
  }

  clearActiveTask(agentId: string): void {
    if (!this.sharedKv) return;
    this.sharedKv.delete(["agents", agentId, "active_task"]).catch(
      () => {/* best-effort */},
    );
  }

  writeTaskObservation(msg: WorkerTaskObserveMessage): void {
    if (!this.sharedKv) return;
    const task = { ...msg, timestamp: new Date().toISOString() };
    this.sharedKv.atomic()
      .set(["task_observations", msg.taskId], task)
      .set(["_dashboard", "task_observation_update"], task)
      .commit()
      .catch(() => {/* best-effort */});
  }
}
