import { page } from "@fresh/core";
import { getBrokerUrl } from "../../lib/api-client.ts";
import type { AgentTaskEntry } from "../../lib/types.ts";

interface A2AData {
  tasks: AgentTaskEntry[];
  brokerUrl: string;
}

function StatusBadge({ status }: { status: string }) {
  const variant: Record<string, string> = {
    completed: "badge-success",
    running: "badge-info",
    sent: "badge-info",
    received: "badge-warning",
    failed: "badge-error",
  };
  return <span class={`badge badge-xs ${variant[status] ?? "badge-ghost"}`}>{status}</span>;
}

export const handler = {
  async GET(_req: Request) {
    const brokerUrl = getBrokerUrl();
    let tasks: AgentTaskEntry[] = [];
    try {
      const token = Deno.env.get("DENOCLAW_API_TOKEN") || "";
      const headers: HeadersInit = token ? { "Authorization": `Bearer ${token}` } : {};
      const res = await fetch(`${brokerUrl}/agents/tasks`, { headers });
      if (res.ok) tasks = await res.json();
    } catch { /* gateway not running */ }
    return page({ tasks, brokerUrl } as A2AData);
  },
};

export default function A2AHub({ data }: { data: A2AData }) {
  const { tasks } = data;
  const running = tasks.filter((t) => t.status === "running" || t.status === "sent" || t.status === "received");
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
          <div class="stat-value font-data text-success">{completed.length}</div>
        </div>
        <div class="stat">
          <div class="stat-title">Failed</div>
          <div class="stat-value font-data text-error">{failed.length}</div>
        </div>
      </div>

      {/* Filters */}
      <div class="flex items-center gap-4">
        <input type="text" placeholder="Search tasks..." class="input input-sm bg-base-200 font-data w-64" />
        <div class="join">
          <button class="join-item btn btn-sm btn-primary">All</button>
          <button class="join-item btn btn-sm btn-ghost text-info">Running</button>
          <button class="join-item btn btn-sm btn-ghost text-success">Completed</button>
          <button class="join-item btn btn-sm btn-ghost text-error">Failed</button>
        </div>
      </div>

      {/* Chain Table */}
      {tasks.length === 0 ? (
        <div role="alert" class="alert">No A2A tasks recorded yet. Agents communicate via the send_to_agent tool.</div>
      ) : (
        <div class="overflow-x-auto">
          <table class="table table-sm bg-base-200">
            <thead>
              <tr class="text-neutral-content font-data text-xs uppercase tracking-wider">
                <th>Task ID</th>
                <th>From → To</th>
                <th>Status</th>
                <th>Message</th>
                <th class="text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.taskId} class={`hover ${task.status === "running" || task.status === "sent" ? "border-l-2 border-primary" : ""}`}>
                  <td class="font-data text-xs text-primary">{task.taskId.slice(0, 12)}...</td>
                  <td>
                    <span class="font-medium">{task.from}</span>
                    <span class="text-neutral-content mx-1">→</span>
                    <span class="font-medium">{task.to}</span>
                  </td>
                  <td><StatusBadge status={task.status} /></td>
                  <td class="text-sm text-neutral-content truncate max-w-xs">{task.message}</td>
                  <td class="text-right font-data text-xs text-neutral-content">{task.timestamp}</td>
                </tr>
              ))}
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
