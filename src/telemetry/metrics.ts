import { log } from "../shared/log.ts";
import {
  listAgentMetrics,
  readA2AFrequencyMatrix,
  readAgentMetrics,
  readHourlyA2A,
  readHourlyMetrics,
  readHourlyToolUsage,
  readToolBreakdown,
  summarizeMetrics,
} from "./metrics_queries.ts";
import type {
  A2AFrequencyEntry,
  AgentMetrics,
  HourlyA2ABucket,
  HourlyBucket,
  HourlyToolBucket,
  ToolMetrics,
} from "./metrics_types.ts";
export type {
  A2AFrequencyEntry,
  AgentMetrics,
  HourlyA2ABucket,
  HourlyBucket,
  HourlyToolBucket,
  ToolMetrics,
} from "./metrics_types.ts";

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
    return await readAgentMetrics(await this.getKv(), agentId);
  }

  async getAllMetrics(): Promise<AgentMetrics[]> {
    return await listAgentMetrics(await this.getKv());
  }

  async getSummary(): Promise<{
    totalAgents: number;
    totalLLMCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    totalToolCalls: number;
    totalA2AMessages: number;
  }> {
    return summarizeMetrics(await this.getAllMetrics());
  }

  // ── Per-tool breakdown ────────────────────────────

  async getToolBreakdown(agentId: string): Promise<ToolMetrics[]> {
    return await readToolBreakdown(await this.getKv(), agentId);
  }

  // ── Hourly time-series ───────────────────────────

  async getHourlyMetrics(
    agentId: string,
    from: string,
    to: string,
  ): Promise<HourlyBucket[]> {
    return await readHourlyMetrics(await this.getKv(), agentId, from, to);
  }

  // ── Hourly A2A time-series ───────────────────────

  async getHourlyA2A(
    agentId: string,
    from: string,
    to: string,
  ): Promise<HourlyA2ABucket[]> {
    return await readHourlyA2A(await this.getKv(), agentId, from, to);
  }

  // ── Agent→Agent frequency matrix ─────────────────

  async getA2AFrequencyMatrix(
    from: string,
    to: string,
  ): Promise<A2AFrequencyEntry[]> {
    return await readA2AFrequencyMatrix(await this.getKv(), from, to);
  }

  // ── Hourly tool usage ────────────────────────────

  async getHourlyToolUsage(
    agentId: string,
    from: string,
    to: string,
  ): Promise<HourlyToolBucket[]> {
    return await readHourlyToolUsage(await this.getKv(), agentId, from, to);
  }

  close(): void {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }
}
