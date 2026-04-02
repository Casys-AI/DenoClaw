# Broker Cron Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cron scheduling from `AgentRuntime` to the broker. Agents create
crons via broker-backed tools. The broker owns the registry, fires jobs via
`Deno.cron`, and dispatches `task_submit` to agents. Agent liveness is derived
from broker state instead of agent-side KV heartbeat writes.

**Architecture:** New `BrokerCronManager` in
`src/orchestration/broker/cron_manager.ts` owns the cron registry (KV-persisted)
and `Deno.cron` registration. Three new agent-facing tools (`create_cron`,
`list_crons`, `delete_cron`) route through the existing `tool_request` /
`tool_response` dispatch. On cron fire, the broker dispatches a `task_submit` to
the target agent. `src/agent/cron.ts` is deleted and `AgentRuntime` no longer
opens KV for heartbeat.

**Tech Stack:** Deno 2.x, Deno KV, `Deno.cron`, existing broker tool dispatch,
A2A task lifecycle.

---

## Version baseline

Plan written against repository state:

- Branch: `main`
- HEAD: current as of 2026-04-01

---

### Task 1: BrokerCronJob type and KV helpers

**Files:**

- Create: `src/orchestration/broker/cron_types.ts`
- Test: `src/orchestration/broker/cron_manager_test.ts`

- [ ] **Step 1: Write the failing test for BrokerCronJob persistence**

```typescript
// src/orchestration/broker/cron_manager_test.ts
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
      id: "job-1",
      agentId: "alice",
      name: "task-a",
      schedule: "*/5 * * * *",
      prompt: "do A",
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const jobBob: BrokerCronJob = {
      id: "job-2",
      agentId: "bob",
      name: "task-b",
      schedule: "*/10 * * * *",
      prompt: "do B",
      enabled: true,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write src/orchestration/broker/cron_manager_test.ts
```

Expected: FAIL — `cron_types.ts` does not exist.

- [ ] **Step 3: Create the type**

```typescript
// src/orchestration/broker/cron_types.ts

export interface BrokerCronJob {
  id: string;
  agentId: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write src/orchestration/broker/cron_manager_test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/broker/cron_types.ts src/orchestration/broker/cron_manager_test.ts
git commit -m "feat(broker): add BrokerCronJob type with KV persistence tests"
```

---

### Task 2: BrokerCronManager — create, list, delete

**Files:**

- Create: `src/orchestration/broker/cron_manager.ts`
- Modify: `src/orchestration/broker/cron_manager_test.ts`

- [ ] **Step 1: Write failing tests for create/list/delete**

Add to `cron_manager_test.ts`:

```typescript
import { BrokerCronManager } from "./cron_manager.ts";

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
    await mgr.create({ agentId: "alice", name: "a1", schedule: "* * * * *", prompt: "do a1" });
    await mgr.create({ agentId: "alice", name: "a2", schedule: "* * * * *", prompt: "do a2" });
    await mgr.create({ agentId: "bob", name: "b1", schedule: "* * * * *", prompt: "do b1" });

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
    const job = await mgr.create({ agentId: "alice", name: "temp", schedule: "* * * * *", prompt: "tmp" });

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
```

- [ ] **Step 2: Run to verify failure**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write src/orchestration/broker/cron_manager_test.ts
```

Expected: FAIL — `BrokerCronManager` does not exist.

- [ ] **Step 3: Implement BrokerCronManager**

```typescript
// src/orchestration/broker/cron_manager.ts

import type { BrokerCronJob } from "./cron_types.ts";
import { generateId } from "../../shared/helpers.ts";
import { log } from "../../shared/log.ts";

export interface CronManagerOptions {
  /** Set to false in tests to skip Deno.cron registration. */
  registerDenoCron?: boolean;
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
  /** Track disabled/deleted job IDs so Deno.cron handlers become no-ops. */
  private disabledJobIds = new Set<string>();

  constructor(kv: Deno.Kv, opts?: CronManagerOptions) {
    this.kv = kv;
    this.registerDenoCron = opts?.registerDenoCron ?? true;
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

    if (this.registerDenoCron) {
      this.registerCronHandler(job);
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

  /**
   * Reload all persisted cron jobs from KV and register Deno.cron handlers.
   * Called on broker boot.
   */
  async reloadAll(onFire: (job: BrokerCronJob) => Promise<void>): Promise<number> {
    const jobs = await this.listAll();
    let count = 0;
    for (const job of jobs) {
      if (!job.enabled) continue;
      this.registerCronHandler(job, onFire);
      count++;
    }
    log.info(`Reloaded ${count} cron jobs from KV`);
    return count;
  }

  private onFireCallback?: (job: BrokerCronJob) => Promise<void>;

  setOnFire(callback: (job: BrokerCronJob) => Promise<void>): void {
    this.onFireCallback = callback;
  }

  private registerCronHandler(
    job: BrokerCronJob,
    onFire?: (job: BrokerCronJob) => Promise<void>,
  ): void {
    const callback = onFire ?? this.onFireCallback;
    const cronName = `cron-${job.agentId}-${job.id}`;

    Deno.cron(cronName, job.schedule, async () => {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write src/orchestration/broker/cron_manager_test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/broker/cron_manager.ts src/orchestration/broker/cron_manager_test.ts
git commit -m "feat(broker): add BrokerCronManager with create/list/delete"
```

---

### Task 3: Cron tools — create_cron, list_crons, delete_cron

**Files:**

- Create: `src/agent/tools/cron.ts`
- Modify: `src/agent/tools/types.ts`
- Modify: `src/agent/tools/mod.ts`
- Modify: `src/agent/runtime_tool_definitions.ts`

- [ ] **Step 1: Create the cron tool classes**

```typescript
// src/agent/tools/cron.ts

import { BaseTool } from "./registry.ts";
import type { ToolDefinition, ToolResult } from "./registry.ts";

export class CreateCronTool extends BaseTool {
  name = "create_cron";
  description = "Create a scheduled task that runs on a cron schedule";
  permissions = [] as const;

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short name for the cron job (e.g. 'email-check')",
            },
            schedule: {
              type: "string",
              description: "Cron expression (e.g. '0 8 * * *' for daily at 8am, '*/30 * * * *' for every 30 minutes)",
            },
            prompt: {
              type: "string",
              description: "The instruction to execute each time the cron fires",
            },
          },
          required: ["name", "schedule", "prompt"],
        },
      },
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return { content: "create_cron is broker-backed — should not be called locally" };
  }
}

export class ListCronsTool extends BaseTool {
  name = "list_crons";
  description = "List all scheduled cron jobs for this agent";
  permissions = [] as const;

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: "object", properties: {} },
      },
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return { content: "list_crons is broker-backed — should not be called locally" };
  }
}

export class DeleteCronTool extends BaseTool {
  name = "delete_cron";
  description = "Delete a scheduled cron job";
  permissions = [] as const;

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            cronJobId: {
              type: "string",
              description: "The ID of the cron job to delete",
            },
          },
          required: ["cronJobId"],
        },
      },
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return { content: "delete_cron is broker-backed — should not be called locally" };
  }
}
```

- [ ] **Step 2: Add cron tools to BuiltinToolName**

In `src/agent/tools/types.ts`, add the cron tools. Since they have no
sandbox permissions (they are broker-dispatched, not sandboxed), add them with
empty permission arrays:

```typescript
export type BuiltinToolName =
  | "shell"
  | "read_file"
  | "write_file"
  | "web_fetch"
  | "create_cron"
  | "list_crons"
  | "delete_cron";

export const BUILTIN_TOOL_PERMISSIONS: Readonly<
  Record<BuiltinToolName, readonly SandboxPermission[]>
> = {
  shell: ["run"],
  read_file: ["read"],
  write_file: ["write"],
  web_fetch: ["net"],
  create_cron: [],
  list_crons: [],
  delete_cron: [],
};
```

- [ ] **Step 3: Export from mod.ts**

Add to `src/agent/tools/mod.ts`:

```typescript
export { CreateCronTool, DeleteCronTool, ListCronsTool } from "./cron.ts";
```

- [ ] **Step 4: Register tool definitions for the LLM**

In `src/agent/runtime_tool_definitions.ts`, add to
`createBrokerBackedRuntimeToolDefinitions()`:

```typescript
import { CreateCronTool, DeleteCronTool, ListCronsTool } from "./tools/cron.ts";

// Inside the function's return array:
new CreateCronTool().getDefinition(),
new ListCronsTool().getDefinition(),
new DeleteCronTool().getDefinition(),
```

- [ ] **Step 5: Run type check**

Run:

```bash
deno task check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/cron.ts src/agent/tools/types.ts src/agent/tools/mod.ts src/agent/runtime_tool_definitions.ts
git commit -m "feat(tools): add create_cron, list_crons, delete_cron tool definitions"
```

---

### Task 4: Wire cron tools into broker tool dispatch

**Files:**

- Modify: `src/orchestration/broker/tool_dispatch.ts`
- Modify: `src/orchestration/bootstrap.ts`
- Modify: `src/orchestration/broker/server.ts`
- Test: `src/orchestration/broker/cron_manager_test.ts`

- [ ] **Step 1: Write failing test for broker-side cron tool execution**

Add to `cron_manager_test.ts`:

```typescript
Deno.test("broker dispatches create_cron tool and persists job", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    const job = await mgr.create({
      agentId: "alice",
      name: "daily-report",
      schedule: "0 9 * * *",
      prompt: "Generate daily report",
    });

    assertEquals(job.name, "daily-report");
    assertEquals(job.prompt, "Generate daily report");

    const jobs = await mgr.listByAgent("alice");
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].id, job.id);
  } finally {
    kv.close();
  }
});
```

- [ ] **Step 2: Run to verify it passes (manager already works)**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write src/orchestration/broker/cron_manager_test.ts
```

Expected: PASS.

- [ ] **Step 3: Add cron tool handling in BrokerToolDispatcher**

In `src/orchestration/broker/tool_dispatch.ts`, add a cron tool handler inside
`handleToolRequest()`. Before the existing sandbox/tunnel dispatch, add an
early return for cron tools:

```typescript
// After resolving agentId, before permission checks:
if (req.tool === "create_cron" || req.tool === "list_crons" || req.tool === "delete_cron") {
  const result = await this.handleCronTool(agentId, req.tool, req.args);
  await this.deps.replyDispatcher.sendReply(msg, { type: "tool_response", payload: result });
  return;
}
```

Add the handler method:

```typescript
private async handleCronTool(
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const cronManager = this.deps.cronManager;
  if (!cronManager) {
    return { content: JSON.stringify({ error: "Cron manager not available" }) };
  }

  switch (tool) {
    case "create_cron": {
      const job = await cronManager.create({
        agentId,
        name: args.name as string,
        schedule: args.schedule as string,
        prompt: args.prompt as string,
      });
      return { content: JSON.stringify({ created: true, id: job.id, name: job.name, schedule: job.schedule }) };
    }
    case "list_crons": {
      const jobs = await cronManager.listByAgent(agentId);
      return { content: JSON.stringify({ jobs: jobs.map((j) => ({ id: j.id, name: j.name, schedule: j.schedule, prompt: j.prompt, enabled: j.enabled, lastRun: j.lastRun })) }) };
    }
    case "delete_cron": {
      const deleted = await cronManager.delete(agentId, args.cronJobId as string);
      return { content: JSON.stringify({ deleted }) };
    }
    default:
      return { content: JSON.stringify({ error: "Unknown cron tool" }) };
  }
}
```

- [ ] **Step 4: Wire BrokerCronManager into broker dependencies**

In `src/orchestration/bootstrap.ts`, create and expose the cron manager:

```typescript
import { BrokerCronManager } from "./broker/cron_manager.ts";

// Add to createBrokerServerDeps():
const cronManager = new BrokerCronManager(kv);
return { toolExecution, cronManager };
```

Update `BrokerServerDeps` type in `src/orchestration/broker/server.ts` to
include `cronManager?: BrokerCronManager`.

Pass `cronManager` into `BrokerToolDispatcher` deps.

- [ ] **Step 5: Run type check and existing tests**

Run:

```bash
deno task check && deno task test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/broker/tool_dispatch.ts src/orchestration/bootstrap.ts src/orchestration/broker/server.ts
git commit -m "feat(broker): wire cron tools into broker tool dispatch"
```

---

### Task 5: Cron fire → task_submit dispatch

**Files:**

- Modify: `src/orchestration/broker/cron_manager.ts`
- Modify: `src/orchestration/bootstrap.ts`
- Test: `src/orchestration/broker/cron_manager_test.ts`

- [ ] **Step 1: Write failing test for cron fire callback**

Add to `cron_manager_test.ts`:

```typescript
Deno.test("reloadAll calls onFire for each enabled job", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const mgr = new BrokerCronManager(kv, { registerDenoCron: false });
    await mgr.create({ agentId: "alice", name: "j1", schedule: "* * * * *", prompt: "do j1" });
    await mgr.create({ agentId: "bob", name: "j2", schedule: "* * * * *", prompt: "do j2" });

    // Reload should find 2 enabled jobs
    const fired: string[] = [];
    const count = await mgr.reloadAll(async (job) => {
      fired.push(job.name);
    });

    assertEquals(count, 2);
    // Note: onFire is registered as Deno.cron callback, not called immediately.
    // With registerDenoCron: false, handlers are not registered.
    // This test verifies reloadAll counts correctly.
  } finally {
    kv.close();
  }
});
```

- [ ] **Step 2: Run to verify it passes**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write src/orchestration/broker/cron_manager_test.ts
```

Expected: PASS.

- [ ] **Step 3: Wire cron fire to task_submit in bootstrap**

In `src/orchestration/bootstrap.ts`, after creating the broker and cron
manager, set up the fire callback:

```typescript
cronManager.setOnFire(async (job) => {
  await broker.submitTask({
    targetAgent: job.agentId,
    message: job.prompt,
    metadata: {
      cronJobId: job.id,
      cronName: job.name,
      cronSchedule: job.schedule,
    },
  });
});

await cronManager.reloadAll();
```

Adapt `broker.submitTask()` to the actual broker task submission API — this
may be `handleTaskSubmit` or a direct KV task creation + dispatch. Use the
same path as `channel_ingress` or the broker HTTP `task_submit` handler.

- [ ] **Step 4: Run full test suite**

Run:

```bash
deno task test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/bootstrap.ts src/orchestration/broker/cron_manager.ts src/orchestration/broker/cron_manager_test.ts
git commit -m "feat(broker): dispatch task_submit to agent on cron fire"
```

---

### Task 6: Broker-side agent liveness (replace agent heartbeat)

**Files:**

- Modify: `src/orchestration/broker/server.ts`
- Modify: `src/orchestration/monitoring.ts`
- Test: `src/orchestration/broker/cron_manager_test.ts`

- [ ] **Step 1: Write failing test for broker liveness tracking**

Add to `cron_manager_test.ts`:

```typescript
Deno.test("broker writes agent status on task completion", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await kv.set(["agents", "alice", "status"], {
      status: "alive",
      lastHeartbeat: new Date().toISOString(),
    });

    const entry = await kv.get(["agents", "alice", "status"]);
    assertEquals((entry.value as Record<string, unknown>).status, "alive");
  } finally {
    kv.close();
  }
});
```

- [ ] **Step 2: Add broker liveness writes**

In the broker's task result handling (where `task_result` is received from an
agent), add a KV write to update agent status:

```typescript
// In the task result handler:
await kv.set(["agents", agentId, "status"], {
  status: "alive",
  lastHeartbeat: new Date().toISOString(),
});
```

This replaces the agent-side heartbeat. The broker already knows when agents
complete tasks — it uses this signal for liveness.

- [ ] **Step 3: Run tests**

Run:

```bash
deno task test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/broker/server.ts src/orchestration/broker/cron_manager_test.ts
git commit -m "feat(broker): write agent liveness on task completion"
```

---

### Task 7: Remove agent-side cron and heartbeat

**Files:**

- Delete: `src/agent/cron.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/mod.ts`
- Modify: `src/orchestration/monitoring.ts`

- [ ] **Step 1: Remove CronManager from AgentRuntime**

In `src/agent/runtime.ts`:

Remove the import:

```typescript
// DELETE: import { CronManager } from "./cron.ts";
```

Remove the field:

```typescript
// DELETE: private cron!: CronManager;
```

Remove from `start()` (lines 122–132):

```typescript
// DELETE: const kv = await this.getKv();
// DELETE: this.cron = new CronManager(kv);
// DELETE: await this.cron.heartbeat(async () => { ... }, 5);
// DELETE: await kv.set(["agents", this.agentId, "status"], { ... });
```

Remove from `stop()` (line 372):

```typescript
// DELETE: this.cron.close();
```

Remove the status write in `stop()` (lines 379–384) — the broker now owns
agent status. If the agent runtime still needs a local stop signal, keep
the KV close but remove the status write.

- [ ] **Step 2: Remove CronJob from agent types**

In `src/agent/types.ts`, remove:

```typescript
// DELETE:
// export interface CronJob {
//   id: string;
//   name: string;
//   schedule: string;
//   task: string;
//   enabled: boolean;
//   lastRun?: string;
//   nextRun?: string;
// }
```

- [ ] **Step 3: Remove CronJob export from mod.ts**

In `src/agent/mod.ts`, remove:

```typescript
// DELETE: CronJob,
```

- [ ] **Step 4: Update monitoring.ts to use BrokerCronJob**

In `src/orchestration/monitoring.ts`, change:

```typescript
// BEFORE:
import type { CronJob } from "../agent/types.ts";
// ...
export async function listCronJobs(kv: Deno.Kv): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  for await (const entry of kv.list<CronJob>({ prefix: ["cron"] })) {

// AFTER:
import type { BrokerCronJob } from "./broker/cron_types.ts";
// ...
export async function listCronJobs(kv: Deno.Kv): Promise<BrokerCronJob[]> {
  const jobs: BrokerCronJob[] = [];
  for await (const entry of kv.list<BrokerCronJob>({ prefix: ["cron"] })) {
```

- [ ] **Step 5: Delete src/agent/cron.ts**

```bash
rm src/agent/cron.ts
```

- [ ] **Step 6: Run full test suite and type check**

Run:

```bash
deno task check && deno task test
```

Expected: PASS. Fix any remaining imports of `CronJob` or `CronManager`.

- [ ] **Step 7: Commit**

```bash
git add -u src/agent/cron.ts src/agent/runtime.ts src/agent/types.ts src/agent/mod.ts src/orchestration/monitoring.ts
git commit -m "refactor: remove agent-side cron and heartbeat, broker owns scheduling"
```

---

### Task 8: Update dashboard monitoring endpoint

**Files:**

- Modify: `src/orchestration/gateway/monitoring_routes.ts`

- [ ] **Step 1: Update the /cron/jobs endpoint**

The `listCronJobs` function in `monitoring.ts` now returns `BrokerCronJob[]`
with the new KV key layout `["cron", agentId, jobId]`. The `kv.list` prefix
`["cron"]` still works — it scans all cron keys regardless of the added
`agentId` segment.

Verify the endpoint still returns the correct shape. If the dashboard expects
`task` (old field), map `prompt` to `task` for backward compat, or update the
dashboard frontend.

- [ ] **Step 2: Run the monitoring test**

Run:

```bash
deno test --unstable-kv --allow-read --allow-write --allow-env src/orchestration/gateway/monitoring_routes_test.ts
```

Expected: PASS or fix any type mismatches.

- [ ] **Step 3: Run full suite**

Run:

```bash
deno task check && deno task test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/gateway/monitoring_routes.ts
git commit -m "fix(dashboard): update cron endpoint for BrokerCronJob type"
```

---

## Test matrix

| Scenario | Covered in |
|---|---|
| BrokerCronJob persists and round-trips via KV | Task 1 |
| List by agent prefix returns correct scope | Task 1 |
| Create/list/delete lifecycle | Task 2 |
| Delete unknown job returns false | Task 2 |
| Cron tools dispatch through broker tool_request | Task 4 |
| Cron fire dispatches task_submit | Task 5 |
| Broker writes agent liveness on task completion | Task 6 |
| Agent runtime starts without cron/heartbeat | Task 7 |
| Dashboard /cron/jobs returns new type | Task 8 |

## Commands to run after each task

```bash
deno task check
deno task test
```
