import type { BrokerCronJob } from "./cron_types.ts";
import { generateId } from "../../shared/helpers.ts";
import { log } from "../../shared/log.ts";

export interface CronManagerOptions {
  registerDenoCron?: boolean;
  registerCron?: typeof Deno.cron;
}

export interface CreateCronParams {
  agentId: string;
  name: string;
  schedule: string;
  prompt: string;
}

export class BrokerCronManager {
  private kv: Deno.Kv;
  private registerDenoCron: boolean;
  private registerCronImpl: typeof Deno.cron;
  private disabledJobIds = new Set<string>();
  private onFireCallback?: (job: BrokerCronJob) => Promise<void>;

  constructor(kv: Deno.Kv, opts?: CronManagerOptions) {
    this.kv = kv;
    this.registerDenoCron = opts?.registerDenoCron ?? true;
    this.registerCronImpl = opts?.registerCron ?? Deno.cron;
  }

  async create(params: CreateCronParams): Promise<BrokerCronJob> {
    const job: BrokerCronJob = {
      id: generateId(),
      agentId: params.agentId,
      name: params.name,
      schedule: params.schedule,
      prompt: params.prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    await this.kv.set(["cron", job.agentId, job.id], job);
    try {
      if (this.registerDenoCron) {
        this.registerCronHandler(job);
      }
    } catch (error) {
      await this.kv.delete(["cron", job.agentId, job.id]);
      throw error;
    }
    log.info(`Cron created: ${job.name} for agent ${job.agentId} (${job.schedule})`);
    return job;
  }

  async listByAgent(agentId: string): Promise<BrokerCronJob[]> {
    const jobs: BrokerCronJob[] = [];
    for await (const entry of this.kv.list<BrokerCronJob>({ prefix: ["cron", agentId] })) {
      if (entry.value) jobs.push(entry.value);
    }
    return jobs;
  }

  async listAll(): Promise<BrokerCronJob[]> {
    const jobs: BrokerCronJob[] = [];
    for await (const entry of this.kv.list<BrokerCronJob>({ prefix: ["cron"] })) {
      if (entry.value) jobs.push(entry.value);
    }
    return jobs;
  }

  async delete(agentId: string, jobId: string): Promise<boolean> {
    const entry = await this.kv.get<BrokerCronJob>(["cron", agentId, jobId]);
    if (!entry.value) return false;
    await this.kv.delete(["cron", agentId, jobId]);
    this.disabledJobIds.add(jobId);
    log.info(`Cron deleted: ${entry.value.name} for agent ${agentId}`);
    return true;
  }

  async reloadAll(onFire?: (job: BrokerCronJob) => Promise<void>): Promise<number> {
    const jobs = await this.listAll();
    let count = 0;
    for (const job of jobs) {
      if (!job.enabled) continue;
      try {
        this.registerCronHandler(job, onFire);
        count++;
      } catch (e) {
        log.error(`Failed to reload cron ${job.name} (${job.id}): invalid schedule?`, e);
        await this.kv.delete(["cron", job.agentId, job.id]);
      }
    }
    log.info(`Reloaded ${count} cron jobs from KV`);
    return count;
  }

  setOnFire(callback: (job: BrokerCronJob) => Promise<void>): void {
    this.onFireCallback = callback;
  }

  private registerCronHandler(job: BrokerCronJob, onFire?: (job: BrokerCronJob) => Promise<void>): void {
    const callback = onFire ?? this.onFireCallback;
    const cronName = `cron-${job.agentId}-${job.id}`;
    this.registerCronImpl(cronName, job.schedule, async () => {
      if (this.disabledJobIds.has(job.id)) return;
      const current = await this.kv.get<BrokerCronJob>(["cron", job.agentId, job.id]);
      if (!current.value || !current.value.enabled) return;
      current.value.lastRun = new Date().toISOString();
      await this.kv.set(["cron", job.agentId, job.id], current.value);
      if (callback) {
        try {
          await callback(current.value);
          log.info(`Cron fired: ${job.name} for agent ${job.agentId}`);
        } catch (e) {
          log.error(`Cron fire failed: ${job.name} for agent ${job.agentId}`, e);
        }
      }
    });
  }
}
