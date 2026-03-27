import type { CronJob } from "./types.ts";
import { log } from "../shared/log.ts";
import { generateId } from "../shared/helpers.ts";

/**
 * Cron & Heartbeat manager.
 *
 * Utilise Deno.cron() natif — fonctionne en local (--unstable-cron) et sur Deploy.
 * Pas de fallback setInterval, on assume que le flag est toujours présent.
 */
export class CronManager {
  private jobs = new Map<string, CronJob>();
  private kv: Deno.Kv | null = null;

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
          log.info(`Cron terminé : ${job.name}`);
        } catch (e) {
          log.error(`Cron échoué : ${job.name}`, e);
        }
      });

      this.jobs.set(job.id, job);
      await this.persistJob(job);
      log.info(`Cron planifié : ${job.name} (${job.schedule})`);
      return true;
    } catch (e) {
      log.error(`Échec planification cron ${job.name}`, e);
      return false;
    }
  }

  /**
   * Heartbeat — raccourci pour un cron récurrent.
   * L'agent se réveille périodiquement pour vérifier s'il a des tâches,
   * envoyer des messages proactifs, check les tunnels, etc.
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
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }
}
