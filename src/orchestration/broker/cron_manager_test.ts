import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { BrokerCronManager } from "./cron_manager.ts";

function createRegisterCronStub(
  callbacks: Map<string, () => Promise<void> | void>,
): typeof Deno.cron {
  return ((
    name: string,
    _schedule: string | Deno.CronSchedule,
    ...rest: [
      (() => Promise<void> | void) | {
        backoffSchedule?: number[];
        signal?: AbortSignal;
      },
      (() => Promise<void> | void)?,
    ]
  ) => {
    const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
    if (!callback) {
      throw new Error("Expected cron handler callback");
    }
    callbacks.set(name, callback);
    return Promise.resolve();
  }) as typeof Deno.cron;
}

Deno.test("BrokerCronManager.create persists job and returns it", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const job = await mgr.create({
      agentId: "alice",
      name: "email-check",
      schedule: "0 8 * * *",
      prompt: "Check my emails",
    });
    assertEquals(job.agentId, "alice");
    assertEquals(job.name, "email-check");
    assertEquals(job.enabled, true);
    assertEquals(typeof job.id, "string");
    assertEquals(typeof job.createdAt, "string");
  } finally {
    kv.close();
  }
});

Deno.test("BrokerCronManager.listByAgent returns only that agent's jobs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    await mgr.create({
      agentId: "alice",
      name: "a1",
      schedule: "* * * * *",
      prompt: "do a1",
    });
    await mgr.create({
      agentId: "alice",
      name: "a2",
      schedule: "* * * * *",
      prompt: "do a2",
    });
    await mgr.create({
      agentId: "bob",
      name: "b1",
      schedule: "* * * * *",
      prompt: "do b1",
    });
    const aliceJobs = await mgr.listByAgent("alice");
    assertEquals(aliceJobs.length, 2);
    const bobJobs = await mgr.listByAgent("bob");
    assertEquals(bobJobs.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("BrokerCronManager.delete removes job from KV", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const job = await mgr.create({
      agentId: "alice",
      name: "temp",
      schedule: "* * * * *",
      prompt: "tmp",
    });
    const deleted = await mgr.delete(job.agentId, job.id);
    assertEquals(deleted, true);
    const remaining = await mgr.listByAgent("alice");
    assertEquals(remaining.length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("BrokerCronManager.delete returns false for unknown job", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const deleted = await mgr.delete("alice", "nonexistent");
    assertEquals(deleted, false);
  } finally {
    kv.close();
  }
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

Deno.test("BrokerCronManager.disable skips scheduled callbacks until re-enabled", async () => {
  const kv = await Deno.openKv(":memory:");
  const callbacks = new Map<string, () => Promise<void> | void>();
  const fired: string[] = [];
  try {
    const mgr = new BrokerCronManager(kv, {
      registerDenoCron: true,
      registerCron: createRegisterCronStub(callbacks),
    });
    mgr.setOnFire((job) => {
      fired.push(job.id);
      return Promise.resolve();
    });

    const job = await mgr.create({
      agentId: "alice",
      name: "heartbeat",
      schedule: "* * * * *",
      prompt: "ping",
    });
    await mgr.disable(job.agentId, job.id);

    const callback = callbacks.get(`cron-${job.agentId}-${job.id}`);
    assertExists(callback);
    await callback();
    assertEquals(fired, []);

    const disabledEntry = await kv.get<{
      enabled: boolean;
    }>(["cron", job.agentId, job.id]);
    assertEquals(disabledEntry.value?.enabled, false);

    await mgr.enable(job.agentId, job.id);
    assertEquals(callbacks.size, 1);
    await callback();
    assertEquals(fired, [job.id]);

    const enabledEntry = await kv.get<{
      enabled: boolean;
      lastRun?: string;
    }>(["cron", job.agentId, job.id]);
    assertEquals(enabledEntry.value?.enabled, true);
    assertEquals(typeof enabledEntry.value?.lastRun, "string");
  } finally {
    kv.close();
  }
});

Deno.test("BrokerCronManager.reloadAll registers persisted jobs and fires them", async () => {
  const kv = await Deno.openKv(":memory:");
  const callbacks = new Map<string, () => Promise<void> | void>();
  const fired: string[] = [];
  try {
    await kv.set(["cron", "alice", "job-1"], {
      id: "job-1",
      agentId: "alice",
      name: "daily-check",
      schedule: "0 8 * * *",
      prompt: "Check inbox",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const mgr = new BrokerCronManager(kv, {
      registerDenoCron: true,
      registerCron: createRegisterCronStub(callbacks),
    });
    mgr.setOnFire((job) => {
      fired.push(job.id);
      return Promise.resolve();
    });

    const count = await mgr.reloadAll();
    assertEquals(count, 1);

    const callback = callbacks.get("cron-alice-job-1");
    assertExists(callback);
    await callback();
    assertEquals(fired, ["job-1"]);

    const entry = await kv.get<{ lastRun?: string }>([
      "cron",
      "alice",
      "job-1",
    ]);
    assertEquals(typeof entry.value?.lastRun, "string");
  } finally {
    kv.close();
  }
});

Deno.test("BrokerCronManager forwards the runtime shutdown signal to Deno.cron", async () => {
  const kv = await Deno.openKv(":memory:");
  const callbacks = new Map<string, () => Promise<void> | void>();
  const signals = new Map<string, AbortSignal | undefined>();
  const shutdown = new AbortController();
  try {
    const mgr = new BrokerCronManager(kv, {
      signal: shutdown.signal,
      registerCron: ((
        name: string,
        _schedule: string | Deno.CronSchedule,
        ...rest: [
          (() => Promise<void> | void) | {
            backoffSchedule?: number[];
            signal?: AbortSignal;
          },
          (() => Promise<void> | void)?,
        ]
      ) => {
        const options = typeof rest[0] === "function" ? undefined : rest[0];
        const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
        if (!callback) throw new Error("Expected cron handler callback");
        callbacks.set(name, callback);
        signals.set(name, options?.signal);
        return Promise.resolve();
      }) as typeof Deno.cron,
    });

    const job = await mgr.create({
      agentId: "alice",
      name: "heartbeat",
      schedule: "* * * * *",
      prompt: "ping",
    });

    assertExists(callbacks.get(`cron-${job.agentId}-${job.id}`));
    assertEquals(signals.get(`cron-${job.agentId}-${job.id}`), shutdown.signal);
  } finally {
    kv.close();
  }
});
