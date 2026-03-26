import { log } from "../utils/log.ts";

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

    await kv.atomic()
      .sum(["metrics", agentId, "llm", "calls"], 1n)
      .sum(["metrics", agentId, "llm", "promptTokens"], BigInt(tokens.prompt))
      .sum(["metrics", agentId, "llm", "completionTokens"], BigInt(tokens.completion))
      .sum(["metrics", agentId, "llm", "totalTokens"], BigInt(total))
      .sum(["metrics", agentId, "llm", "totalCostMicro"], BigInt(Math.round(cost * 1_000_000)))
      .sum(["metrics", agentId, "llm", "totalLatencyMs"], BigInt(Math.round(latencyMs)))
      .commit();

    log.debug(`Metrics LLM: ${agentId} +${total} tokens, +$${cost.toFixed(4)}, ${latencyMs}ms`);
  }

  // ── Tool metrics ───────────────────────────────────

  async recordToolCall(
    agentId: string,
    tool: string,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    const kv = await this.getKv();

    const ops = kv.atomic()
      .sum(["metrics", agentId, "tools", "calls"], 1n)
      .sum(["metrics", agentId, "tools", "totalLatencyMs"], BigInt(Math.round(latencyMs)));

    if (success) {
      ops.sum(["metrics", agentId, "tools", "successes"], 1n);
    } else {
      ops.sum(["metrics", agentId, "tools", "failures"], 1n);
    }

    await ops.commit();
    log.debug(`Metrics tool: ${agentId} ${tool} ${success ? "ok" : "fail"} ${latencyMs}ms`);
  }

  // ── A2A metrics ────────────────────────────────────

  async recordA2AMessage(
    fromAgent: string,
    toAgent: string,
  ): Promise<void> {
    const kv = await this.getKv();

    await kv.atomic()
      .sum(["metrics", fromAgent, "a2a", "sent"], 1n)
      .sum(["metrics", toAgent, "a2a", "received"], 1n)
      .commit();

    // Track unique peers
    const peersEntry = await kv.get<string[]>(["metrics", fromAgent, "a2a", "peers"]);
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
    const completionTokens = await get(["metrics", agentId, "llm", "completionTokens"]);
    const totalTokens = await get(["metrics", agentId, "llm", "totalTokens"]);
    const totalCostMicro = await get(["metrics", agentId, "llm", "totalCostMicro"]);
    const llmLatency = await get(["metrics", agentId, "llm", "totalLatencyMs"]);

    const toolCalls = await get(["metrics", agentId, "tools", "calls"]);
    const toolSuccesses = await get(["metrics", agentId, "tools", "successes"]);
    const toolFailures = await get(["metrics", agentId, "tools", "failures"]);
    const toolLatency = await get(["metrics", agentId, "tools", "totalLatencyMs"]);

    const a2aSent = await get(["metrics", agentId, "a2a", "sent"]);
    const a2aReceived = await get(["metrics", agentId, "a2a", "received"]);
    const peersEntry = await kv.get<string[]>(["metrics", agentId, "a2a", "peers"]);

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

  close(): void {
    if (this.kv) { this.kv.close(); this.kv = null; }
  }
}
