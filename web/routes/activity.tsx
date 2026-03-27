import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import ActivityFeed from "../islands/ActivityFeed.tsx";
import {
  getDashboardRequestConfig,
  requireDashboardSession,
} from "../lib/dashboard-auth.ts";

export const handler = {
  GET(ctx: FreshContext) {
    const authErr = requireDashboardSession(ctx.req);
    if (authErr) return authErr;

    const config = getDashboardRequestConfig(ctx.req);
    return page({ brokerUrl: config.brokerUrl });
  },
};

export default function Activity({ data }: { data: { brokerUrl: string } }) {
  return (
    <div class="space-y-4">
      <h1 class="text-2xl font-display font-bold">Activity Feed</h1>
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <ActivityFeed />
        </div>
      </div>
      {Deno.env.get("DENO_DEPLOYMENT_ID")
        ? null
        : (
          <div class="text-xs font-data text-neutral-content">
            Streaming from: {data.brokerUrl} via /api/events proxy
          </div>
        )}
    </div>
  );
}
