/**
 * API client for broker/gateway monitoring endpoints.
 * Supports multi-instance: each function can target a specific instance URL
 * or defaults to the first configured instance.
 */

import type {
  AgentMetrics,
  AgentStatusEntry,
  CronJob,
  HealthResponse,
  MetricsSummary,
} from "./types.ts";
import {
  getDefaultInstance,
  getInstances,
  type Instance,
} from "./instances.ts";

const API_TOKEN = Deno.env.get("DENOCLAW_API_TOKEN") || "";

function headers(): HeadersInit {
  if (!API_TOKEN) return {};
  return { "Authorization": `Bearer ${API_TOKEN}` };
}

async function fetchJSON<T>(
  brokerUrl: string,
  path: string,
): Promise<T | null> {
  try {
    const res = await fetch(`${brokerUrl}${path}`, { headers: headers() });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ── Single-instance queries ────────────────────────

export function getSummary(
  brokerUrl?: string,
): Promise<MetricsSummary | null> {
  return fetchJSON<MetricsSummary>(
    brokerUrl ?? getDefaultInstance().url,
    "/stats",
  );
}

export async function getAllAgentMetrics(
  brokerUrl?: string,
): Promise<AgentMetrics[]> {
  return await fetchJSON<AgentMetrics[]>(
    brokerUrl ?? getDefaultInstance().url,
    "/stats/agents",
  ) ?? [];
}

export function getAgentMetrics(
  agentId: string,
  brokerUrl?: string,
): Promise<AgentMetrics | null> {
  return fetchJSON<AgentMetrics>(
    brokerUrl ?? getDefaultInstance().url,
    `/stats?agent=${encodeURIComponent(agentId)}`,
  );
}

export async function getAgents(
  brokerUrl?: string,
): Promise<AgentStatusEntry[]> {
  return await fetchJSON<AgentStatusEntry[]>(
    brokerUrl ?? getDefaultInstance().url,
    "/agents",
  ) ?? [];
}

export function getAgent(
  agentId: string,
  brokerUrl?: string,
): Promise<AgentStatusEntry | null> {
  return fetchJSON<AgentStatusEntry>(
    brokerUrl ?? getDefaultInstance().url,
    `/agents/${encodeURIComponent(agentId)}`,
  );
}

export function getHealth(
  brokerUrl?: string,
): Promise<HealthResponse | null> {
  return fetchJSON<HealthResponse>(
    brokerUrl ?? getDefaultInstance().url,
    "/health",
  );
}

export async function getCronJobs(brokerUrl?: string): Promise<CronJob[]> {
  return await fetchJSON<CronJob[]>(
    brokerUrl ?? getDefaultInstance().url,
    "/cron",
  ) ?? [];
}

export function getBrokerUrl(): string {
  return getDefaultInstance().url;
}

// ── Multi-instance aggregation ─────────────────────

export interface InstanceData {
  instance: Instance;
  reachable: boolean;
  summary: MetricsSummary | null;
  agents: AgentStatusEntry[];
  health: HealthResponse | null;
}

/** Fetch data from ALL configured instances in parallel. */
export function getAllInstancesData(): Promise<InstanceData[]> {
  const instances = getInstances();

  return Promise.all(instances.map(async (instance): Promise<InstanceData> => {
    const [summary, agents, health] = await Promise.all([
      getSummary(instance.url),
      getAgents(instance.url),
      getHealth(instance.url),
    ]);

    return {
      instance,
      reachable: summary !== null || agents.length > 0 || health !== null,
      summary,
      agents: agents.map((a) => ({ ...a, instance: instance.name })),
      health,
    };
  }));
}

/** Aggregate summaries across all instances. */
export function aggregateSummaries(data: InstanceData[]): MetricsSummary {
  return data.reduce((acc, d) => ({
    totalAgents: acc.totalAgents + (d.summary?.totalAgents ?? d.agents.length),
    totalLLMCalls: acc.totalLLMCalls + (d.summary?.totalLLMCalls ?? 0),
    totalTokens: acc.totalTokens + (d.summary?.totalTokens ?? 0),
    totalCostUsd: acc.totalCostUsd + (d.summary?.totalCostUsd ?? 0),
    totalToolCalls: acc.totalToolCalls + (d.summary?.totalToolCalls ?? 0),
    totalA2AMessages: acc.totalA2AMessages + (d.summary?.totalA2AMessages ?? 0),
  }), {
    totalAgents: 0,
    totalLLMCalls: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    totalToolCalls: 0,
    totalA2AMessages: 0,
  });
}
