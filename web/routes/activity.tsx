import { page } from "@fresh/core";
import type { FreshContext } from "@fresh/core";
import { getBrokerUrl } from "../lib/api-client.ts";
import ActivityFeed from "../islands/ActivityFeed.tsx";

export const handler = {
  GET(_ctx: FreshContext) {
    return page({ brokerUrl: getBrokerUrl() });
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
      <div class="text-xs font-data text-neutral-content">
        Streaming from: {data.brokerUrl} via /api/events proxy
      </div>
    </div>
  );
}
