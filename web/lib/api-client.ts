/**
 * API client for broker/gateway monitoring endpoints.
 * Supports multi-instance: each function can target a specific instance URL
 * or defaults to the first configured instance.
 */

import type {
  AgentMetrics,
  AgentStatusEntry,
  CronJob,
  FederationStatsSnapshot,
  HealthResponse,
  MetricsSummary,
} from "./types.ts";
import {
  getDefaultInstance,
  getInstances,
  type Instance,
} from "./instances.ts";

const API_TOKEN = Deno.env.get("DENOCLAW_API_TOKEN") || "";

export interface BrokerRequestOptions {
  brokerUrl?: string;
  token?: string;
}

interface FetchJSONOptions {
  timeoutMs?: number;
}

function resolveRequestOptions(
  options?: string | BrokerRequestOptions,
): Required<BrokerRequestOptions> {
  if (typeof options === "string") {
    return { brokerUrl: options, token: API_TOKEN };
  }

  return {
    brokerUrl: options?.brokerUrl ?? getDefaultInstance().url,
    token: options?.token ?? API_TOKEN,
  };
}

function headers(token: string): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJSON<T>(
  path: string,
  options?: string | BrokerRequestOptions,
  fetchOptions?: FetchJSONOptions,
): Promise<T | null> {
  const { brokerUrl, token } = resolveRequestOptions(options);
  const controller = fetchOptions?.timeoutMs
    ? new AbortController()
    : undefined;
  const timeoutId = fetchOptions?.timeoutMs
    ? setTimeout(() => controller?.abort(), fetchOptions.timeoutMs)
    : undefined;

  try {
    const res = await fetch(`${brokerUrl}${path}`, {
      headers: headers(token),
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// ── Single-instance queries ────────────────────────

export function getSummary(
  options?: string | BrokerRequestOptions,
): Promise<MetricsSummary | null> {
  return fetchJSON<MetricsSummary>("/stats", options);
}

export async function getAllAgentMetrics(
  options?: string | BrokerRequestOptions,
): Promise<AgentMetrics[]> {
  return (await fetchJSON<AgentMetrics[]>("/stats/agents", options)) ?? [];
}

export function getAgentMetrics(
  agentId: string,
  options?: string | BrokerRequestOptions,
): Promise<AgentMetrics | null> {
  return fetchJSON<AgentMetrics>(
    `/stats?agent=${encodeURIComponent(agentId)}`,
    options,
  );
}

export async function getAgents(
  options?: string | BrokerRequestOptions,
): Promise<AgentStatusEntry[]> {
  return (await fetchJSON<AgentStatusEntry[]>("/agents", options)) ?? [];
}

export function getAgent(
  agentId: string,
  options?: string | BrokerRequestOptions,
): Promise<AgentStatusEntry | null> {
  return fetchJSON<AgentStatusEntry>(
    `/agents/${encodeURIComponent(agentId)}`,
    options,
  );
}

export function getHealth(
  options?: string | BrokerRequestOptions,
): Promise<HealthResponse | null> {
  return fetchJSON<HealthResponse>("/health", options);
}

export async function getCronJobs(
  options?: string | BrokerRequestOptions,
): Promise<CronJob[]> {
  return (await fetchJSON<CronJob[]>("/cron", options)) ?? [];
}

export function getFederationStats(
  options?: string | BrokerRequestOptions,
): Promise<FederationStatsSnapshot | null> {
  return fetchJSON<FederationStatsSnapshot>("/federation/stats", options, {
    timeoutMs: 1_000,
  });
}

export function getBrokerUrl(options?: string | BrokerRequestOptions): string {
  return resolveRequestOptions(options).brokerUrl;
}

// ── Multi-instance aggregation ─────────────────────

export interface InstanceData {
  instance: Instance;
  reachable: boolean;
  summary: MetricsSummary | null;
  agents: AgentStatusEntry[];
  health: HealthResponse | null;
  federation: FederationStatsSnapshot | null;
}

/** Fetch data from ALL configured instances in parallel. */
export function getAllInstancesData(options?: {
  instances?: Instance[];
  token?: string;
  includeFederation?: boolean;
}): Promise<InstanceData[]> {
  const instances = options?.instances ?? getInstances();
  const token = options?.token ?? API_TOKEN;
  const includeFederation = options?.includeFederation ?? false;

  return Promise.all(
    instances.map(async (instance): Promise<InstanceData> => {
      const [summary, agents, health, federation] = await Promise.all([
        getSummary({ brokerUrl: instance.url, token }),
        getAgents({ brokerUrl: instance.url, token }),
        getHealth({ brokerUrl: instance.url, token }),
        includeFederation
          ? getFederationStats({ brokerUrl: instance.url, token })
          : Promise.resolve(null),
      ]);

      return {
        instance,
        reachable: summary !== null || agents.length > 0 || health !== null,
        summary,
        agents: agents.map((a) => ({ ...a, instance: instance.name })),
        health,
        federation,
      };
    }),
  );
}

/** Aggregate summaries across all instances. */
export function aggregateSummaries(data: InstanceData[]): MetricsSummary {
  return data.reduce(
    (acc, d) => ({
      totalAgents: acc.totalAgents +
        (d.summary?.totalAgents ?? d.agents.length),
      totalLLMCalls: acc.totalLLMCalls + (d.summary?.totalLLMCalls ?? 0),
      totalTokens: acc.totalTokens + (d.summary?.totalTokens ?? 0),
      totalCostUsd: acc.totalCostUsd + (d.summary?.totalCostUsd ?? 0),
      totalToolCalls: acc.totalToolCalls + (d.summary?.totalToolCalls ?? 0),
      totalA2AMessages: acc.totalA2AMessages +
        (d.summary?.totalA2AMessages ?? 0),
    }),
    {
      totalAgents: 0,
      totalLLMCalls: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      totalToolCalls: 0,
      totalA2AMessages: 0,
    },
  );
}
