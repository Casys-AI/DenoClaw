/**
 * Monitoring helpers — shared between Gateway and Broker.
 * Reads agent status, cron jobs, and agent tasks from KV.
 */

import type { CronJob } from "../agent/types.ts";
import type {
  ActiveTaskEntry,
  AgentStatusEntry,
  AgentStatusValue,
  TaskObservationEntry,
} from "../shared/types.ts";

export type {
  ActiveTaskEntry,
  AgentStatusEntry,
  AgentStatusValue,
  TaskObservationEntry,
};

// ── KV readers ─────────────────────────────────────────

export async function listAgentStatuses(
  kv: Deno.Kv,
): Promise<AgentStatusEntry[]> {
  const entries: AgentStatusEntry[] = [];
  const activeTaskMap = new Map<string, ActiveTaskEntry>();

  for await (const entry of kv.list({ prefix: ["agents"] })) {
    const agentId = entry.key[1] as string;
    const subKey = entry.key[2] as string;

    if (entry.key.length === 3 && subKey === "status" && entry.value) {
      entries.push({
        agentId,
        ...(entry.value as AgentStatusValue),
      });
    }
    if (entry.key.length === 3 && subKey === "active_task" && entry.value) {
      activeTaskMap.set(agentId, entry.value as ActiveTaskEntry);
    }
  }

  // Attach active tasks to their agents
  for (const e of entries) {
    e.activeTask = activeTaskMap.get(e.agentId) ?? null;
  }
  return entries;
}

export async function getAgentStatus(
  kv: Deno.Kv,
  agentId: string,
): Promise<AgentStatusEntry | null> {
  const [statusEntry, taskEntry] = await Promise.all([
    kv.get<AgentStatusValue>(["agents", agentId, "status"]),
    kv.get<ActiveTaskEntry>(["agents", agentId, "active_task"]),
  ]);
  if (!statusEntry.value) return null;
  return {
    agentId,
    ...statusEntry.value,
    activeTask: taskEntry.value ?? null,
  };
}

export async function listCronJobs(kv: Deno.Kv): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  for await (const entry of kv.list<CronJob>({ prefix: ["cron"] })) {
    if (entry.value) jobs.push(entry.value);
  }
  return jobs;
}

/** Update the dashboard agents list sentinel — triggers kv.watch() refresh. */
export async function updateAgentsList(
  kv: Deno.Kv,
  agentIds: string[],
): Promise<void> {
  await kv.set(["_dashboard", "agents_list"], agentIds);
}

/** Write agent status to shared KV. */
export async function writeAgentStatus(
  kv: Deno.Kv,
  agentId: string,
  value: AgentStatusValue,
): Promise<void> {
  await kv.set(["agents", agentId, "status"], value);
}

// ── SSE helpers ────────────────────────────────────────

export type DashboardEvent =
  | { type: "snapshot"; agents: AgentStatusEntry[] }
  | { type: "agent_status"; agentId: string; status: AgentStatusValue }
  | { type: "agents_list_updated"; agentIds: string[] }
  | { type: "task_observation"; task: TaskObservationEntry }
  | { type: "keepalive" };

export async function listTaskObservations(
  kv: Deno.Kv,
  limit = 50,
): Promise<TaskObservationEntry[]> {
  const tasks: TaskObservationEntry[] = [];
  for await (
    const entry of kv.list<TaskObservationEntry>({
      prefix: ["task_observations"],
    })
  ) {
    if (entry.value) tasks.push(entry.value);
    if (tasks.length >= limit) break;
  }
  return tasks.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Build the list of KV keys to watch for dashboard updates. */
export function buildWatchKeys(agentIds: string[]): Deno.KvKey[] {
  return [
    ["_dashboard", "agents_list"],
    ["_dashboard", "task_observation_update"],
    ...agentIds.map((id) => ["agents", id, "status"] as Deno.KvKey),
  ];
}

/** Convert a KV watch entry to a dashboard event. */
export function kvEntryToDashboardEvent(
  entry: Deno.KvEntryMaybe<unknown>,
): DashboardEvent | null {
  const key = entry.key;

  // ["_dashboard", "agents_list"] → agents_list_updated
  if (key[0] === "_dashboard" && key[1] === "agents_list") {
    return {
      type: "agents_list_updated",
      agentIds: (entry.value as string[]) ?? [],
    };
  }

  // ["_dashboard", "task_observation_update"] → task_observation
  if (
    key[0] === "_dashboard" && key[1] === "task_observation_update" &&
    entry.value
  ) {
    return {
      type: "task_observation",
      task: entry.value as TaskObservationEntry,
    };
  }

  // ["agents", agentId, "status"] → agent_status
  if (
    key[0] === "agents" && key.length === 3 && key[2] === "status" &&
    entry.value
  ) {
    return {
      type: "agent_status",
      agentId: key[1] as string,
      status: entry.value as AgentStatusValue,
    };
  }

  return null;
}

const SSE_ENCODER = new TextEncoder();

function encodeSSE(event: DashboardEvent): Uint8Array {
  return SSE_ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Create an SSE Response that streams KV watch events.
 * Handles agents_list changes by restarting the watch loop with new keys.
 */
export function createSSEResponse(
  kv: Deno.Kv,
  initialAgentIds: string[],
): Response {
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let agentIds = [...initialAgentIds];

      // Send initial snapshot
      const agents = await listAgentStatuses(kv);
      controller.enqueue(encodeSSE({ type: "snapshot", agents }));

      // Keepalive interval (30s)
      const keepalive = setInterval(() => {
        if (!cancelled) {
          try {
            controller.enqueue(encodeSSE({ type: "keepalive" }));
          } catch {
            // stream closed
          }
        }
      }, 30_000);

      try {
        while (!cancelled) {
          const watchKeys = buildWatchKeys(agentIds);
          let listChanged = false;

          const stream = kv.watch(watchKeys);
          for await (const entries of stream) {
            if (cancelled) break;
            for (const entry of entries) {
              const event = kvEntryToDashboardEvent(entry);
              if (!event) continue;
              controller.enqueue(encodeSSE(event));

              // If agents list changed, update and restart watch
              if (event.type === "agents_list_updated") {
                agentIds = event.agentIds;
                listChanged = true;
              }
            }
            if (listChanged) break; // restart watch with new keys
          }
        }
      } catch {
        // stream cancelled or KV closed — exit silently
      } finally {
        clearInterval(keepalive);
        try {
          controller.close();
        } catch { /* already closed */ }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
