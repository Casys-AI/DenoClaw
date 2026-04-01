import { assertEquals, assertRejects } from "@std/assert";
import { BrokerCronManager } from "./cron_manager.ts";

Deno.test("BrokerCronManager.create persists job and returns it", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const job = await mgr.create({
      agentId: "alice", name: "email-check",
      schedule: "0 8 * * *", prompt: "Check my emails",
    });
    assertEquals(job.agentId, "alice");
    assertEquals(job.name, "email-check");
    assertEquals(job.enabled, true);
    assertEquals(typeof job.id, "string");
    assertEquals(typeof job.createdAt, "string");
  } finally { kv.close(); }
});

Deno.test("BrokerCronManager.listByAgent returns only that agent's jobs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    await mgr.create({ agentId: "alice", name: "a1", schedule: "* * * * *", prompt: "do a1" });
    await mgr.create({ agentId: "alice", name: "a2", schedule: "* * * * *", prompt: "do a2" });
    await mgr.create({ agentId: "bob", name: "b1", schedule: "* * * * *", prompt: "do b1" });
    const aliceJobs = await mgr.listByAgent("alice");
    assertEquals(aliceJobs.length, 2);
    const bobJobs = await mgr.listByAgent("bob");
    assertEquals(bobJobs.length, 1);
  } finally { kv.close(); }
});

Deno.test("BrokerCronManager.delete removes job from KV", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const job = await mgr.create({ agentId: "alice", name: "temp", schedule: "* * * * *", prompt: "tmp" });
    const deleted = await mgr.delete(job.agentId, job.id);
    assertEquals(deleted, true);
    const remaining = await mgr.listByAgent("alice");
    assertEquals(remaining.length, 0);
  } finally { kv.close(); }
});

Deno.test("BrokerCronManager.delete returns false for unknown job", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const deleted = await mgr.delete("alice", "nonexistent");
    assertEquals(deleted, false);
  } finally { kv.close(); }
});

Deno.test("BrokerCronManager.create rolls back KV when cron registration fails", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, {
      registerDenoCron: true,
      registerCron: () => {
        throw new Error("invalid schedule");
      },
    });

    await assertRejects(
      () =>
        mgr.create({
          agentId: "alice",
          name: "broken",
          schedule: "bad cron",
          prompt: "noop",
        }),
      Error,
      "invalid schedule",
    );

    const jobs = await mgr.listByAgent("alice");
    assertEquals(jobs, []);
  } finally {
    kv.close();
  }
});
