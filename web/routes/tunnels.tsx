import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getHealth } from "../lib/api-client.ts";
import type { HealthResponse } from "../lib/types.ts";

export const handler = {
  async GET(_ctx: FreshContext) {
    const health = await getHealth();
    return page(health);
  },
};

export default function Tunnels({ data }: { data: HealthResponse | null }) {
  const tunnels = data?.tunnels ?? [];

  return (
    <div class="space-y-6">
      <h1 class="text-2xl font-bold">Tunnels</h1>

      <div class="stats bg-base-100 shadow">
        <div class="stat">
          <div class="stat-title">Connected</div>
          <div class="stat-value text-primary">{data?.tunnelCount ?? 0}</div>
        </div>
      </div>

      {tunnels.length === 0 ? (
        <div class="alert">No tunnels connected.</div>
      ) : (
        <div class="overflow-x-auto">
          <table class="table table-zebra bg-base-100 shadow rounded-box">
            <thead>
              <tr>
                <th>Tunnel ID</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tunnels.map((id) => (
                <tr key={id}>
                  <td class="font-mono text-sm">{id}</td>
                  <td><span class="badge badge-success badge-sm">connected</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
