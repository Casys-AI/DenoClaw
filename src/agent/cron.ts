import type { CronJob } from "./types.ts";
import { log } from "../shared/log.ts";
import { generateId } from "../shared/helpers.ts";

/**
 * Cron & heartbeat manager.
 *
 * Uses native Deno.cron() — works locally (--unstable-cron) and on Deploy.
 * No setInterval fallback; we assume the flag is always present.
 */
export class CronManager {
  private jobs = new Map<string, CronJob>();
  private kv: Deno.Kv | null = null;
  private ownsKv: boolean;

  constructor(kv?: Deno.Kv) {
    if (kv) {
      this.kv = kv;
      this.ownsKv = false;
    } else {
      this.ownsKv = true;
    }
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  /**
   * Schedule a cron job via Deno.cron().
   */
  async schedule(
    job: CronJob,
    callback: () => void | Promise<void>,
  ): Promise<boolean> {
    try {
      Deno.cron(job.name, job.schedule, async () => {
        if (!job.enabled) return;
        job.lastRun = new Date().toISOString();
        await this.persistJob(job);
        try {
          await callback();
          log.info(`Cron completed: ${job.name}`);
        } catch (e) {
          log.error(`Cron failed: ${job.name}`, e);
        }
      });

      this.jobs.set(job.id, job);
      await this.persistJob(job);
      log.info(`Cron scheduled: ${job.name} (${job.schedule})`);
      return true;
    } catch (e) {
      log.error(`Failed to schedule cron ${job.name}`, e);
      return false;
    }
  }

  /**
   * Heartbeat — shorthand for a recurring cron.
   * The agent wakes periodically to check for tasks, send proactive messages,
   * check tunnels, etc.
   */
  async heartbeat(
    callback: () => void | Promise<void>,
    intervalMinutes = 5,
  ): Promise<boolean> {
    const job: CronJob = {
      id: generateId(),
      name: "heartbeat",
      schedule: `*/${intervalMinutes} * * * *`,
      task: "heartbeat",
      enabled: true,
    };
    return await this.schedule(job, callback);
  }

  unschedule(jobId: string): void {
    this.jobs.delete(jobId);
  }

  getAll(): CronJob[] {
    return [...this.jobs.values()];
  }

  private async persistJob(job: CronJob): Promise<void> {
    const kv = await this.getKv();
    await kv.set(["cron", job.id], job);
  }

  async loadJobs(): Promise<CronJob[]> {
    const kv = await this.getKv();
    const jobs: CronJob[] = [];
    for await (const entry of kv.list<CronJob>({ prefix: ["cron"] })) {
      if (entry.value) jobs.push(entry.value);
    }
    return jobs;
  }

  close(): void {
    if (this.kv && this.ownsKv) {
      this.kv.close();
      this.kv = null;
    }
  }
}
