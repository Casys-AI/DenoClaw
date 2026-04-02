import { getConfiguredAnalyticsStore } from "./analytics.ts";
import { log } from "../shared/log.ts";

let analyticsAggregationRegistered = false;

export function registerAnalyticsAggregationCron(): void {
  if (analyticsAggregationRegistered) return;

  const analytics = getConfiguredAnalyticsStore();
  if (!analytics) return;

  analyticsAggregationRegistered = true;

  Deno.cron("daily-metrics-aggregation", "0 2 * * *", async () => {
    const targetDate = startOfUtcDay(addDays(new Date(), -1));
    const date = formatDate(targetDate);
    try {
      await analytics.aggregateDailyMetrics({ date: targetDate });
      log.info("analytics: aggregated daily metrics", { date });
    } catch (error) {
      log.warn(
        "analytics: failed to aggregate daily metrics",
        {
          date,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  });
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
