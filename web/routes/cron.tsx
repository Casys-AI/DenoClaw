import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getCronJobs } from "../lib/api-client.ts";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";
import { formatRelative } from "../lib/format.ts";
import type { CronJob } from "../lib/types.ts";

export const handler = {
  async GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const dashboard = getDashboardRequestConfig(ctx.req);
    const jobs = await getCronJobs({
      brokerUrl: dashboard.brokerUrl,
      token: dashboard.token,
    });
    return page(jobs);
  },
};

export default function Cron({ data }: { data: CronJob[] }) {
  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-bold">Cron Jobs</h1>

      {data.length === 0
        ? <div class="alert">No cron jobs configured.</div>
        : (
          <div class="overflow-x-auto">
            <table class="table table-zebra bg-base-100 shadow rounded-box">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Schedule</th>
                  <th>Task</th>
                  <th>Enabled</th>
                  <th>Last Run</th>
                  <th>Next Run</th>
                </tr>
              </thead>
              <tbody>
                {data.map((job) => (
                  <tr key={job.id}>
                    <td class="font-medium">{job.name}</td>
                    <td class="font-mono text-sm">{job.schedule}</td>
                    <td class="text-sm">{job.task}</td>
                    <td>
                      <span
                        class={`badge badge-sm ${
                          job.enabled ? "badge-success" : "badge-ghost"
                        }`}
                      >
                        {job.enabled ? "on" : "off"}
                      </span>
                    </td>
                    <td class="text-sm">
                      {job.lastRun ? formatRelative(job.lastRun) : "—"}
                    </td>
                    <td class="text-sm">
                      {job.nextRun ? formatRelative(job.nextRun) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
