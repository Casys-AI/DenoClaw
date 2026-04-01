import { assertEquals } from "@std/assert";
import type { BrokerCronJob } from "./cron_types.ts";

Deno.test("BrokerCronJob round-trips through KV", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const job: BrokerCronJob = {
      id: "job-1",
      agentId: "alice",
      name: "email-check",
      schedule: "0 8 * * *",
      prompt: "Check my emails and summarize them",
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    await kv.set(["cron", job.agentId, job.id], job);
    const entry = await kv.get<BrokerCronJob>(["cron", "alice", "job-1"]);
    assertEquals(entry.value?.name, "email-check");
    assertEquals(entry.value?.prompt, "Check my emails and summarize them");
    assertEquals(entry.value?.agentId, "alice");
  } finally {
    kv.close();
  }
});

Deno.test("list cron jobs by agent prefix", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const jobAlice: BrokerCronJob = {
      id: "job-1", agentId: "alice", name: "task-a",
      schedule: "*/5 * * * *", prompt: "do A", enabled: true,
      createdAt: new Date().toISOString(),
    };
    const jobBob: BrokerCronJob = {
      id: "job-2", agentId: "bob", name: "task-b",
      schedule: "*/10 * * * *", prompt: "do B", enabled: true,
      createdAt: new Date().toISOString(),
    };
    await kv.set(["cron", "alice", "job-1"], jobAlice);
    await kv.set(["cron", "bob", "job-2"], jobBob);
    const aliceJobs: BrokerCronJob[] = [];
    for await (const entry of kv.list<BrokerCronJob>({ prefix: ["cron", "alice"] })) {
      if (entry.value) aliceJobs.push(entry.value);
    }
    assertEquals(aliceJobs.length, 1);
    assertEquals(aliceJobs[0].name, "task-a");
  } finally {
    kv.close();
  }
});
