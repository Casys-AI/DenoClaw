import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getBrokerUrl } from "../../lib/api-client.ts";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import type { AgentTaskEntry } from "../../lib/types.ts";

interface A2AData {
  tasks: AgentTaskEntry[];
  brokerUrl: string;
  statusFilter: string;
  searchQuery: string;
}

export const handler = {
  async GET(ctx: FreshContext) {
    const brokerUrl = getBrokerUrl();
    const statusFilter = ctx.url.searchParams.get("status") || "all";
    const searchQuery = ctx.url.searchParams.get("q") || "";
    let tasks: AgentTaskEntry[] = [];
    try {
      const token = Deno.env.get("DENOCLAW_API_TOKEN") || "";
      const headers: HeadersInit = token
        ? { "Authorization": `Bearer ${token}` }
        : {};
      const res = await fetch(`${brokerUrl}/agents/tasks`, { headers });
      if (res.ok) tasks = await res.json();
    } catch { /* gateway not running */ }

    // Filter by status
    if (statusFilter !== "all") {
      if (statusFilter === "running") {
        tasks = tasks.filter((t) =>
          t.status === "running" || t.status === "sent" ||
          t.status === "received"
        );
      } else {
        tasks = tasks.filter((t) => t.status === statusFilter);
      }
    }

    // Filter by search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tasks = tasks.filter((t) =>
        t.message?.toLowerCase().includes(q) ||
        t.taskId?.toLowerCase().includes(q) ||
        t.from?.toLowerCase().includes(q) ||
        t.to?.toLowerCase().includes(q)
      );
    }

    return page({ tasks, brokerUrl, statusFilter, searchQuery } as A2AData);
  },
};

export default function A2AHub({ data }: { data: A2AData }) {
  const { tasks, statusFilter, searchQuery } = data;
  // Counts from unfiltered would be ideal but we use what we have
  const running = tasks.filter((t) =>
    t.status === "running" || t.status === "sent" || t.status === "received"
  );
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");

  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">A2A Chain Hub</h1>

      {/* KPIs — DaisyUI stats */}
      <div class="stats stats-vertical sm:stats-horizontal w-full bg-base-200">
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
      <div class="flex flex-wrap items-center gap-4">
        <form method="GET" class="flex items-center gap-2">
          <input
            type="text"
            name="q"
            value={searchQuery}
            placeholder="Search tasks..."
            class="input input-sm bg-base-200 font-data w-64"
          />
          {statusFilter !== "all" && (
            <input type="hidden" name="status" value={statusFilter} />
          )}
        </form>
        <div class="join">
          <a
            href="?status=all"
            class={`join-item btn btn-sm ${
              statusFilter === "all" ? "btn-primary" : "btn-ghost"
            }`}
          >
            All
          </a>
          <a
            href="?status=running"
            class={`join-item btn btn-sm ${
              statusFilter === "running" ? "btn-info" : "btn-ghost text-info"
            }`}
          >
            Running
          </a>
          <a
            href="?status=completed"
            class={`join-item btn btn-sm ${
              statusFilter === "completed"
                ? "btn-success"
                : "btn-ghost text-success"
            }`}
          >
            Completed
          </a>
          <a
            href="?status=failed"
            class={`join-item btn btn-sm ${
              statusFilter === "failed" ? "btn-error" : "btn-ghost text-error"
            }`}
          >
            Failed
          </a>
        </div>
      </div>

      {/* Chain Table */}
      {tasks.length === 0
        ? (
          <div role="alert" class="alert alert-info">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              class="stroke-current w-6 h-6 shrink-0"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>
              No A2A tasks recorded yet. Agents communicate via the{" "}
              <code class="font-data">send_to_agent</code> tool.
            </span>
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
                            <span class="text-primary" title={task.taskId}>
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
                          <span title={task.taskId}>
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
