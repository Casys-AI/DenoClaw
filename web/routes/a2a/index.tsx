import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getBrokerUrl } from "../../lib/api-client.ts";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import type { AgentTaskEntry } from "../../lib/types.ts";

interface A2AData {
  tasks: AgentTaskEntry[];
  brokerUrl: string;
}

export const handler = {
  async GET(_ctx: FreshContext) {
    const brokerUrl = getBrokerUrl();
    let tasks: AgentTaskEntry[] = [];
    try {
      const token = Deno.env.get("DENOCLAW_API_TOKEN") || "";
      const headers: HeadersInit = token
        ? { "Authorization": `Bearer ${token}` }
        : {};
      const res = await fetch(`${brokerUrl}/agents/tasks`, { headers });
      if (res.ok) tasks = await res.json();
    } catch { /* gateway not running */ }
    return page({ tasks, brokerUrl } as A2AData);
  },
};

export default function A2AHub({ data }: { data: A2AData }) {
  const { tasks } = data;
  const running = tasks.filter((t) =>
    t.status === "running" || t.status === "sent" || t.status === "received"
  );
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">A2A Chain Hub</h1>

      {/* KPIs — DaisyUI stats */}
      <div class="stats stats-horizontal w-full bg-base-200">
        <div class="stat">
          <div class="stat-title">Total Tasks</div>
          <div class="stat-value font-data">{tasks.length}</div>
        </div>
        <div class="stat">
          <div class="stat-title">Running Now</div>
          <div class="stat-value font-data text-info">{running.length}</div>
        </div>
        <div class="stat">
          <div class="stat-title">Completed</div>
          <div class="stat-value font-data text-success">
            {completed.length}
          </div>
        </div>
        <div class="stat">
          <div class="stat-title">Failed</div>
          <div class="stat-value font-data text-error">{failed.length}</div>
        </div>
      </div>

      {/* Filters */}
      <div class="flex items-center gap-4">
        <input
          type="text"
          placeholder="Search tasks..."
          class="input input-sm bg-base-200 font-data w-64"
        />
        <div class="join">
          <button type="button" class="join-item btn btn-sm btn-primary">
            All
          </button>
          <button
            type="button"
            class="join-item btn btn-sm btn-ghost text-info"
          >
            Running
          </button>
          <button
            type="button"
            class="join-item btn btn-sm btn-ghost text-success"
          >
            Completed
          </button>
          <button
            type="button"
            class="join-item btn btn-sm btn-ghost text-error"
          >
            Failed
          </button>
        </div>
      </div>

      {/* Chain Table */}
      {tasks.length === 0
        ? (
          <div role="alert" class="alert">
            No A2A tasks recorded yet. Agents communicate via the send_to_agent
            tool.
          </div>
        )
        : (
          <div class="overflow-x-auto">
            <table class="table table-sm bg-base-200">
              <thead>
                <tr class="text-neutral-content font-data text-xs uppercase tracking-wider">
                  <th>Chain</th>
                  <th>Task ID</th>
                  <th>From → To</th>
                  <th>Status</th>
                  <th>Message</th>
                  <th class="text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Group tasks by traceId into chains
                  const chains = new Map<string, typeof tasks>();
                  const orphans: typeof tasks = [];
                  for (const task of tasks) {
                    if (task.traceId) {
                      const chain = chains.get(task.traceId) ?? [];
                      chain.push(task);
                      chains.set(task.traceId, chain);
                    } else {
                      orphans.push(task);
                    }
                  }

                  const rows: preact.JSX.Element[] = [];

                  // Render chains (grouped by traceId)
                  for (const [traceId, chainTasks] of chains) {
                    const sorted = chainTasks.sort((a, b) =>
                      a.timestamp.localeCompare(b.timestamp)
                    );
                    const isActive = sorted.some((t) =>
                      t.status === "sent" || t.status === "received"
                    );

                    sorted.forEach((task, idx) => {
                      const isFirst = idx === 0;
                      const isLast = idx === sorted.length - 1;
                      const treeChar = sorted.length === 1
                        ? "─"
                        : isFirst
                        ? "┌"
                        : isLast
                        ? "└"
                        : "├";

                      rows.push(
                        <tr
                          key={task.taskId}
                          class={`hover ${
                            isActive ? "border-l-2 border-primary" : ""
                          }`}
                        >
                          <td class="font-data text-xs text-neutral-content w-24">
                            {isFirst && (
                              <span class="text-primary" title={traceId}>
                                {traceId.slice(0, 8)}
                              </span>
                            )}
                          </td>
                          <td class="font-data text-xs">
                            <span class="text-neutral-content mr-1">
                              {treeChar}
                            </span>
                            <span class="text-primary">
                              {task.taskId.slice(0, 10)}...
                            </span>
                          </td>
                          <td>
                            <span class="font-medium">{task.from}</span>
                            <span class="text-neutral-content mx-1">→</span>
                            <span class="font-medium">{task.to}</span>
                          </td>
                          <td>
                            <StatusBadge status={task.status} size="xs" />
                          </td>
                          <td class="text-sm text-neutral-content truncate max-w-xs">
                            {task.message}
                          </td>
                          <td class="text-right font-data text-xs text-neutral-content">
                            {task.timestamp.slice(11, 19)}
                          </td>
                        </tr>,
                      );
                    });
                  }

                  // Render orphans (no traceId)
                  for (const task of orphans) {
                    rows.push(
                      <tr key={task.taskId} class="hover">
                        <td class="font-data text-xs text-neutral-content">
                          —
                        </td>
                        <td class="font-data text-xs text-primary">
                          {task.taskId.slice(0, 10)}...
                        </td>
                        <td>
                          <span class="font-medium">{task.from}</span>
                          <span class="text-neutral-content mx-1">→</span>
                          <span class="font-medium">{task.to}</span>
                        </td>
                        <td>
                          <StatusBadge status={task.status} size="xs" />
                        </td>
                        <td class="text-sm text-neutral-content truncate max-w-xs">
                          {task.message}
                        </td>
                        <td class="text-right font-data text-xs text-neutral-content">
                          {task.timestamp.slice(11, 19)}
                        </td>
                      </tr>,
                    );
                  }

                  return rows;
                })()}
              </tbody>
            </table>
          </div>
        )}

      {/* Footer stats */}
      <div class="text-xs font-data text-neutral-content">
        Showing {tasks.length} tasks
      </div>
    </div>
  );
}
