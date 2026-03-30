import type {
  A2AFrequencyEntry,
  AgentMetrics,
  HourlyA2ABucket,
  HourlyBucket,
  HourlyToolBucket,
  ToolMetrics,
} from "./metrics_types.ts";

async function readCounter(kv: Deno.Kv, key: Deno.KvKey): Promise<number> {
  const entry = await kv.get<Deno.KvU64>(key);
  return Number(entry.value?.value ?? 0n);
}

export async function readAgentMetrics(
  kv: Deno.Kv,
  agentId: string,
): Promise<AgentMetrics> {
  const llmCalls = await readCounter(kv, ["metrics", agentId, "llm", "calls"]);
  const promptTokens = await readCounter(kv, [
    "metrics",
    agentId,
    "llm",
    "promptTokens",
  ]);
  const completionTokens = await readCounter(kv, [
    "metrics",
    agentId,
    "llm",
    "completionTokens",
  ]);
  const totalTokens = await readCounter(kv, [
    "metrics",
    agentId,
    "llm",
    "totalTokens",
  ]);
  const totalCostMicro = await readCounter(kv, [
    "metrics",
    agentId,
    "llm",
    "totalCostMicro",
  ]);
  const llmLatency = await readCounter(kv, [
    "metrics",
    agentId,
    "llm",
    "totalLatencyMs",
  ]);

  const toolCalls = await readCounter(kv, [
    "metrics",
    agentId,
    "tools",
    "calls",
  ]);
  const toolSuccesses = await readCounter(kv, [
    "metrics",
    agentId,
    "tools",
    "successes",
  ]);
  const toolFailures = await readCounter(kv, [
    "metrics",
    agentId,
    "tools",
    "failures",
  ]);
  const toolLatency = await readCounter(kv, [
    "metrics",
    agentId,
    "tools",
    "totalLatencyMs",
  ]);

  const a2aSent = await readCounter(kv, ["metrics", agentId, "a2a", "sent"]);
  const a2aReceived = await readCounter(kv, [
    "metrics",
    agentId,
    "a2a",
    "received",
  ]);
  const peersEntry = await kv.get<string[]>([
    "metrics",
    agentId,
    "a2a",
    "peers",
  ]);

  return {
    agentId,
    llm: {
      calls: llmCalls,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: totalCostMicro / 1_000_000,
      avgLatencyMs: llmCalls > 0 ? Math.round(llmLatency / llmCalls) : 0,
    },
    tools: {
      calls: toolCalls,
      successes: toolSuccesses,
      failures: toolFailures,
      avgLatencyMs: toolCalls > 0 ? Math.round(toolLatency / toolCalls) : 0,
    },
    a2a: {
      messagesSent: a2aSent,
      messagesReceived: a2aReceived,
      peersContacted: peersEntry.value || [],
    },
    lastActivity: new Date().toISOString(),
  };
}

export async function listAgentMetrics(kv: Deno.Kv): Promise<AgentMetrics[]> {
  const agentIds = new Set<string>();

  for await (const entry of kv.list({ prefix: ["metrics"] })) {
    const agentId = entry.key[1] as string;
    agentIds.add(agentId);
  }

  const results: AgentMetrics[] = [];
  for (const agentId of agentIds) {
    results.push(await readAgentMetrics(kv, agentId));
  }
  return results;
}

export function summarizeMetrics(all: AgentMetrics[]): {
  totalAgents: number;
  totalLLMCalls: number;
  totalTokens: number;
  totalCostUsd: number;
  totalToolCalls: number;
  totalA2AMessages: number;
} {
  return {
    totalAgents: all.length,
    totalLLMCalls: all.reduce((sum, agent) => sum + agent.llm.calls, 0),
    totalTokens: all.reduce((sum, agent) => sum + agent.llm.totalTokens, 0),
    totalCostUsd: all.reduce(
      (sum, agent) => sum + agent.llm.estimatedCostUsd,
      0,
    ),
    totalToolCalls: all.reduce((sum, agent) => sum + agent.tools.calls, 0),
    totalA2AMessages: all.reduce(
      (sum, agent) => sum + agent.a2a.messagesSent,
      0,
    ),
  };
}

export async function readToolBreakdown(
  kv: Deno.Kv,
  agentId: string,
): Promise<ToolMetrics[]> {
  const toolNames = new Set<string>();

  for await (
    const entry of kv.list({
      prefix: ["metrics", agentId, "tools", "by_name"],
    })
  ) {
    toolNames.add(entry.key[4] as string);
  }

  const results: ToolMetrics[] = [];
  for (const tool of toolNames) {
    const prefix: Deno.KvKey = ["metrics", agentId, "tools", "by_name", tool];
    const calls = await readCounter(kv, [...prefix, "calls"]);
    const successes = await readCounter(kv, [...prefix, "successes"]);
    const failures = await readCounter(kv, [...prefix, "failures"]);
    const latency = await readCounter(kv, [...prefix, "totalLatencyMs"]);
    results.push({
      tool,
      calls,
      successes,
      failures,
      avgLatencyMs: calls > 0 ? Math.round(latency / calls) : 0,
    });
  }

  return results;
}

export async function readHourlyMetrics(
  kv: Deno.Kv,
  agentId: string,
  from: string,
  to: string,
): Promise<HourlyBucket[]> {
  const bucketMap = new Map<string, HourlyBucket>();

  for await (
    const entry of kv.list<Deno.KvU64>({
      prefix: ["metrics_hourly", agentId],
    })
  ) {
    if (entry.key.length !== 5) continue;

    const provider = entry.key[2] as string;
    const hour = entry.key[3] as string;
    const metric = entry.key[4] as string;

    if (hour < from.slice(0, 13) || hour > to.slice(0, 13)) continue;
    if (
      metric !== "calls" &&
      metric !== "tokens" &&
      metric !== "cost_micro"
    ) {
      continue;
    }

    const bucketKey = `${hour}:${provider}`;
    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, {
        hour,
        provider,
        calls: 0,
        tokens: 0,
        costUsd: 0,
      });
    }

    const bucket = bucketMap.get(bucketKey)!;
    const value = Number((entry.value as Deno.KvU64)?.value ?? 0n);
    if (metric === "calls") bucket.calls = value;
    else if (metric === "tokens") bucket.tokens = value;
    else if (metric === "cost_micro") bucket.costUsd = value / 1_000_000;
  }

  return [...bucketMap.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

export async function readHourlyA2A(
  kv: Deno.Kv,
  agentId: string,
  from: string,
  to: string,
): Promise<HourlyA2ABucket[]> {
  const fromH = from.slice(0, 13);
  const toH = to.slice(0, 13);
  const buckets: HourlyA2ABucket[] = [];

  for await (
    const entry of kv.list<Deno.KvU64>({
      prefix: ["metrics_hourly", agentId, "a2a"],
    })
  ) {
    const hour = entry.key[3] as string;
    const direction = entry.key[4] as string;
    if (hour < fromH || hour > toH) continue;

    let bucket = buckets.find((item) => item.hour === hour);
    if (!bucket) {
      bucket = { hour, sent: 0, received: 0 };
      buckets.push(bucket);
    }

    const value = Number((entry.value as Deno.KvU64)?.value ?? 0n);
    if (direction === "sent") bucket.sent = value;
    else if (direction === "received") bucket.received = value;
  }

  return buckets.sort((a, b) => a.hour.localeCompare(b.hour));
}

export async function readA2AFrequencyMatrix(
  kv: Deno.Kv,
  from: string,
  to: string,
): Promise<A2AFrequencyEntry[]> {
  const fromH = from.slice(0, 13);
  const toH = to.slice(0, 13);
  const matrix = new Map<string, A2AFrequencyEntry>();

  for await (
    const entry of kv.list<Deno.KvU64>({ prefix: ["metrics_hourly"] })
  ) {
    if (entry.key[2] !== "a2a_to") continue;

    const fromAgent = entry.key[1] as string;
    const toAgent = entry.key[3] as string;
    const hour = entry.key[4] as string;
    if (hour < fromH || hour > toH) continue;

    const pairKey = `${fromAgent}→${toAgent}`;
    if (!matrix.has(pairKey)) {
      matrix.set(pairKey, {
        fromAgent,
        toAgent,
        totalCalls: 0,
        hourlyBreakdown: [],
      });
    }

    const value = Number((entry.value as Deno.KvU64)?.value ?? 0n);
    const result = matrix.get(pairKey)!;
    result.totalCalls += value;
    result.hourlyBreakdown.push({ hour, calls: value });
  }

  for (const entry of matrix.values()) {
    entry.hourlyBreakdown.sort((a, b) => a.hour.localeCompare(b.hour));
  }

  return [...matrix.values()].sort((a, b) => b.totalCalls - a.totalCalls);
}

export async function readHourlyToolUsage(
  kv: Deno.Kv,
  agentId: string,
  from: string,
  to: string,
): Promise<HourlyToolBucket[]> {
  const fromH = from.slice(0, 13);
  const toH = to.slice(0, 13);
  const buckets: HourlyToolBucket[] = [];

  for await (
    const entry of kv.list<Deno.KvU64>({
      prefix: ["metrics_hourly", agentId, "tool"],
    })
  ) {
    const hour = entry.key[3] as string;
    const tool = entry.key[4] as string;
    if (hour < fromH || hour > toH) continue;

    const value = Number((entry.value as Deno.KvU64)?.value ?? 0n);
    buckets.push({ hour, tool, calls: value });
  }

  return buckets.sort((a, b) => a.hour.localeCompare(b.hour));
}
