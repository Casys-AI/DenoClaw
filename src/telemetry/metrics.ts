import { log } from "../shared/log.ts";

/**
 * Metrics collector — KV-backed, queryable via /stats endpoint.
 *
 * Tracks per-agent:
 * - LLM calls (count, tokens, estimated cost)
 * - Tool executions (count, duration, success/fail)
 * - A2A messages (sent, received)
 * - Latency distributions
 *
 * Uses Deno KV atomic sum for lock-free counters.
 */

export interface AgentMetrics {
  agentId: string;
  llm: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    avgLatencyMs: number;
  };
  tools: {
    calls: number;
    successes: number;
    failures: number;
    avgLatencyMs: number;
  };
  a2a: {
    messagesSent: number;
    messagesReceived: number;
    peersContacted: string[];
  };
  lastActivity: string;
}

// Rough cost estimates per 1M tokens (input + output averaged)
const COST_PER_MILLION_TOKENS: Record<string, number> = {
  "anthropic": 3.0,
  "openai": 2.5,
  "deepseek": 0.5,
  "groq": 0.3,
  "ollama": 0.1,
  "gemini": 1.0,
  "claude-cli": 3.0,
  "codex-cli": 2.5,
};

export class MetricsCollector {
  private kv: Deno.Kv | null = null;

  constructor(kv?: Deno.Kv) {
    this.kv = kv ?? null;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  // ── LLM metrics ────────────────────────────────────

  async recordLLMCall(
    agentId: string,
    provider: string,
    tokens: { prompt: number; completion: number },
    latencyMs: number,
  ): Promise<void> {
    const kv = await this.getKv();
    const total = tokens.prompt + tokens.completion;
    const costPerToken = (COST_PER_MILLION_TOKENS[provider] || 1.0) / 1_000_000;
    const cost = total * costPerToken;

    // Lifetime totals
    const hourBucket = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    await kv.atomic()
      .sum(["metrics", agentId, "llm", "calls"], 1n)
      .sum(["metrics", agentId, "llm", "promptTokens"], BigInt(tokens.prompt))
      .sum(
        ["metrics", agentId, "llm", "completionTokens"],
        BigInt(tokens.completion),
      )
      .sum(["metrics", agentId, "llm", "totalTokens"], BigInt(total))
      .sum(
        ["metrics", agentId, "llm", "totalCostMicro"],
        BigInt(Math.round(cost * 1_000_000)),
      )
      .sum(
        ["metrics", agentId, "llm", "totalLatencyMs"],
        BigInt(Math.round(latencyMs)),
      )
      // Hourly buckets (for time-series / cost analytics)
      .sum(["metrics_hourly", agentId, provider, hourBucket, "calls"], 1n)
      .sum(
        ["metrics_hourly", agentId, provider, hourBucket, "tokens"],
        BigInt(total),
      )
      .sum(
        ["metrics_hourly", agentId, provider, hourBucket, "cost_micro"],
        BigInt(Math.round(cost * 1_000_000)),
      )
      .commit();

    log.debug(
      `Metrics LLM: ${agentId} +${total} tokens, +$${
        cost.toFixed(4)
      }, ${latencyMs}ms`,
    );
  }

  // ── Tool metrics ───────────────────────────────────

  async recordToolCall(
    agentId: string,
    tool: string,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    const kv = await this.getKv();

    const hourBucket = new Date().toISOString().slice(0, 13);
    const ops = kv.atomic()
      .sum(["metrics", agentId, "tools", "calls"], 1n)
      .sum(
        ["metrics", agentId, "tools", "totalLatencyMs"],
        BigInt(Math.round(latencyMs)),
      )
      // Per-tool breakdown
      .sum(["metrics", agentId, "tools", "by_name", tool, "calls"], 1n)
      .sum(
        ["metrics", agentId, "tools", "by_name", tool, "totalLatencyMs"],
        BigInt(Math.round(latencyMs)),
      )
      // Hourly tool buckets (for pattern detection)
      .sum(["metrics_hourly", agentId, "tool", hourBucket, tool, "calls"], 1n);

    if (success) {
      ops.sum(["metrics", agentId, "tools", "successes"], 1n);
      ops.sum(["metrics", agentId, "tools", "by_name", tool, "successes"], 1n);
    } else {
      ops.sum(["metrics", agentId, "tools", "failures"], 1n);
      ops.sum(["metrics", agentId, "tools", "by_name", tool, "failures"], 1n);
    }

    await ops.commit();
    log.debug(
      `Metrics tool: ${agentId} ${tool} ${
        success ? "ok" : "fail"
      } ${latencyMs}ms`,
    );
  }

  // ── Agent-to-agent metrics ─────────────────────────

  async recordAgentMessage(
    fromAgent: string,
    toAgent: string,
  ): Promise<void> {
    const kv = await this.getKv();
    const hourBucket = new Date().toISOString().slice(0, 13);

    await kv.atomic()
      .sum(["metrics", fromAgent, "a2a", "sent"], 1n)
      .sum(["metrics", toAgent, "a2a", "received"], 1n)
      // Hourly A2A buckets (for peak detection)
      .sum(["metrics_hourly", fromAgent, "a2a", hourBucket, "sent"], 1n)
      .sum(["metrics_hourly", toAgent, "a2a", hourBucket, "received"], 1n)
      // Agent→agent frequency matrix (for pattern detection)
      .sum([
        "metrics_hourly",
        fromAgent,
        "a2a_to",
        toAgent,
        hourBucket,
        "calls",
      ], 1n)
      .commit();

    // Track unique peers
    const peersEntry = await kv.get<string[]>([
      "metrics",
      fromAgent,
      "a2a",
      "peers",
    ]);
    const peers = peersEntry.value || [];
    if (!peers.includes(toAgent)) {
      peers.push(toAgent);
      await kv.set(["metrics", fromAgent, "a2a", "peers"], peers);
    }
  }

  // ── Query metrics ──────────────────────────────────

  async getAgentMetrics(agentId: string): Promise<AgentMetrics> {
    const kv = await this.getKv();

    const get = async (key: Deno.KvKey) => {
      const entry = await kv.get<Deno.KvU64>(key);
      return Number(entry.value?.value ?? 0n);
    };

    const llmCalls = await get(["metrics", agentId, "llm", "calls"]);
    const promptTokens = await get(["metrics", agentId, "llm", "promptTokens"]);
    const completionTokens = await get([
      "metrics",
      agentId,
      "llm",
      "completionTokens",
    ]);
    const totalTokens = await get(["metrics", agentId, "llm", "totalTokens"]);
    const totalCostMicro = await get([
      "metrics",
      agentId,
      "llm",
      "totalCostMicro",
    ]);
    const llmLatency = await get(["metrics", agentId, "llm", "totalLatencyMs"]);

    const toolCalls = await get(["metrics", agentId, "tools", "calls"]);
    const toolSuccesses = await get(["metrics", agentId, "tools", "successes"]);
    const toolFailures = await get(["metrics", agentId, "tools", "failures"]);
    const toolLatency = await get([
      "metrics",
      agentId,
      "tools",
      "totalLatencyMs",
    ]);

    const a2aSent = await get(["metrics", agentId, "a2a", "sent"]);
    const a2aReceived = await get(["metrics", agentId, "a2a", "received"]);
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

  async getAllMetrics(): Promise<AgentMetrics[]> {
    const kv = await this.getKv();
    const agentIds = new Set<string>();

    // Discover all agents with metrics
    for await (const entry of kv.list({ prefix: ["metrics"] })) {
      const agentId = entry.key[1] as string;
      agentIds.add(agentId);
    }

    const results: AgentMetrics[] = [];
    for (const agentId of agentIds) {
      results.push(await this.getAgentMetrics(agentId));
    }
    return results;
  }

  async getSummary(): Promise<{
    totalAgents: number;
    totalLLMCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    totalToolCalls: number;
    totalA2AMessages: number;
  }> {
    const all = await this.getAllMetrics();
    return {
      totalAgents: all.length,
      totalLLMCalls: all.reduce((s, a) => s + a.llm.calls, 0),
      totalTokens: all.reduce((s, a) => s + a.llm.totalTokens, 0),
      totalCostUsd: all.reduce((s, a) => s + a.llm.estimatedCostUsd, 0),
      totalToolCalls: all.reduce((s, a) => s + a.tools.calls, 0),
      totalA2AMessages: all.reduce((s, a) => s + a.a2a.messagesSent, 0),
    };
  }

  // ── Per-tool breakdown ────────────────────────────

  async getToolBreakdown(agentId: string): Promise<ToolMetrics[]> {
    const kv = await this.getKv();
    const toolNames = new Set<string>();

    for await (
      const entry of kv.list({
        prefix: ["metrics", agentId, "tools", "by_name"],
      })
    ) {
      toolNames.add(entry.key[4] as string);
    }

    const get = async (key: Deno.KvKey) => {
      const entry = await kv.get<Deno.KvU64>(key);
      return Number(entry.value?.value ?? 0n);
    };

    const results: ToolMetrics[] = [];
    for (const tool of toolNames) {
      const prefix = ["metrics", agentId, "tools", "by_name", tool];
      const calls = await get([...prefix, "calls"]);
      const successes = await get([...prefix, "successes"]);
      const failures = await get([...prefix, "failures"]);
      const latency = await get([...prefix, "totalLatencyMs"]);
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

  // ── Hourly time-series ───────────────────────────

  async getHourlyMetrics(
    agentId: string,
    from: string,
    to: string,
  ): Promise<HourlyBucket[]> {
    const kv = await this.getKv();
    const bucketMap = new Map<string, HourlyBucket>();

    for await (
      const entry of kv.list<Deno.KvU64>({
        prefix: ["metrics_hourly", agentId],
      })
    ) {
      // Key: ["metrics_hourly", agentId, provider, hourBucket, metric]
      const provider = entry.key[2] as string;
      const hour = entry.key[3] as string;
      const metric = entry.key[4] as string;

      if (hour < from.slice(0, 13) || hour > to.slice(0, 13)) continue;

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
      const val = Number((entry.value as Deno.KvU64)?.value ?? 0n);
      if (metric === "calls") bucket.calls = val;
      else if (metric === "tokens") bucket.tokens = val;
      else if (metric === "cost_micro") bucket.costUsd = val / 1_000_000;
    }

    return [...bucketMap.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  // ── Hourly A2A time-series ───────────────────────

  async getHourlyA2A(
    agentId: string,
    from: string,
    to: string,
  ): Promise<HourlyA2ABucket[]> {
    const kv = await this.getKv();
    const fromH = from.slice(0, 13);
    const toH = to.slice(0, 13);
    const buckets: HourlyA2ABucket[] = [];

    for await (
      const entry of kv.list<Deno.KvU64>({
        prefix: ["metrics_hourly", agentId, "a2a"],
      })
    ) {
      // Key: ["metrics_hourly", agentId, "a2a", hour, "sent"|"received"]
      const hour = entry.key[3] as string;
      const direction = entry.key[4] as string;
      if (hour < fromH || hour > toH) continue;

      let bucket = buckets.find((b) => b.hour === hour);
      if (!bucket) {
        bucket = { hour, sent: 0, received: 0 };
        buckets.push(bucket);
      }
      const val = Number((entry.value as Deno.KvU64)?.value ?? 0n);
      if (direction === "sent") bucket.sent = val;
      else if (direction === "received") bucket.received = val;
    }

    return buckets.sort((a, b) => a.hour.localeCompare(b.hour));
  }

  // ── Agent→Agent frequency matrix ─────────────────

  async getA2AFrequencyMatrix(
    from: string,
    to: string,
  ): Promise<A2AFrequencyEntry[]> {
    const kv = await this.getKv();
    const fromH = from.slice(0, 13);
    const toH = to.slice(0, 13);
    const matrix = new Map<string, A2AFrequencyEntry>();

    for await (
      const entry of kv.list<Deno.KvU64>({ prefix: ["metrics_hourly"] })
    ) {
      // Key: ["metrics_hourly", fromAgent, "a2a_to", toAgent, hour, "calls"]
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
      const e = matrix.get(pairKey)!;
      const val = Number((entry.value as Deno.KvU64)?.value ?? 0n);
      e.totalCalls += val;
      e.hourlyBreakdown.push({ hour, calls: val });
    }

    // Sort hourly breakdowns
    for (const e of matrix.values()) {
      e.hourlyBreakdown.sort((a, b) => a.hour.localeCompare(b.hour));
    }

    return [...matrix.values()].sort((a, b) => b.totalCalls - a.totalCalls);
  }

  // ── Hourly tool usage ────────────────────────────

  async getHourlyToolUsage(
    agentId: string,
    from: string,
    to: string,
  ): Promise<HourlyToolBucket[]> {
    const kv = await this.getKv();
    const fromH = from.slice(0, 13);
    const toH = to.slice(0, 13);
    const buckets: HourlyToolBucket[] = [];

    for await (
      const entry of kv.list<Deno.KvU64>({
        prefix: ["metrics_hourly", agentId, "tool"],
      })
    ) {
      // Key: ["metrics_hourly", agentId, "tool", hour, toolName, "calls"]
      const hour = entry.key[3] as string;
      const tool = entry.key[4] as string;
      if (hour < fromH || hour > toH) continue;

      const val = Number((entry.value as Deno.KvU64)?.value ?? 0n);
      buckets.push({ hour, tool, calls: val });
    }

    return buckets.sort((a, b) => a.hour.localeCompare(b.hour));
  }

  close(): void {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }
}

// ── Additional types ───────────────────────────────

export interface ToolMetrics {
  tool: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
}

export interface HourlyBucket {
  hour: string; // "YYYY-MM-DDTHH"
  provider: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface HourlyA2ABucket {
  hour: string;
  sent: number;
  received: number;
}

export interface A2AFrequencyEntry {
  fromAgent: string;
  toAgent: string;
  totalCalls: number;
  hourlyBreakdown: { hour: string; calls: number }[];
}

export interface HourlyToolBucket {
  hour: string;
  tool: string;
  calls: number;
}
