# ADR-007: Real-Time Dashboard + Deep Agent Observability

**Status:** Proposed **Date:** 2026-03-27

## Context

The broker already sees every message (LLM, tools, A2A), but today the metrics
are aggregated counters (`/stats`). We want to observe **what is happening in
real time and in detail**:

- The state of each agent and tunnel
- Every action inside the agent loop, not just the final result
- The live A2A communication graph

## Decision

### 1. Fresh dashboard with KV watch

A web dashboard (Deno Fresh) observes KV in real time through `kv.watch()`. No
polling, no custom WebSocket layer, direct KV-driven reads.

### 2. Deep observability: trace the agent loop

Today we trace LLM and tool calls at the broker level. We still do not see what
happens **inside** the agent:

```
What we see today:
  agent "coder" → llm_request → llm_response → tool_request → tool_response

What we want to see:
  agent "coder" ReAct loop
    ├── iteration 1
    │   ├── context build (12 messages, 3 skills, 4 tools)
    │   ├── LLM call (claude-sonnet-4-6, 2847 tokens in, 342 out, 1.2s)
    │   ├── tool_call: shell { command: "deno test" }
    │   │   ├── sandbox created (perms: [run], 256MB)
    │   │   ├── execution (1.8s, exit 0)
    │   │   └── sandbox destroyed
    │   └── tool result → continue
    ├── iteration 2
    │   ├── LLM call (342 tokens in, 89 out, 0.6s)
    │   └── final response: "Tests passed."
    └── finished (2 iterations, 3.6s total, $0.012)
```

### How to trace the agent loop

The `AgentRuntime` in a deployed agent app writes trace entries into KV as
execution progresses:

```typescript
// Each agent-loop step is persisted in KV
await kv.set(["traces", agentId, taskId, "iteration", 1, "llm_call"], {
  model: "claude-sonnet-4-6",
  tokensIn: 2847,
  tokensOut: 342,
  latencyMs: 1200,
  timestamp: "...",
});

await kv.set(["traces", agentId, taskId, "iteration", 1, "tool_call", 0], {
  tool: "shell",
  args: { command: "deno test" },
  sandboxPerms: ["run"],
  success: true,
  latencyMs: 1800,
  timestamp: "...",
});
```

The dashboard watches those keys with `kv.watch()` and renders the tree in real
time. You can literally see the agent "think": each iteration, each call, each
tool.

### Trace structure in KV

```
["traces", agentId, taskId]                        → task metadata
["traces", agentId, taskId, "iteration", N]        → iteration summary
["traces", agentId, taskId, "iteration", N, "llm_call"]    → LLM detail
["traces", agentId, taskId, "iteration", N, "tool_call", M] → tool detail
["traces", agentId, taskId, "result"]              → final result
```

### Dashboard views

**1. Network view** — agent and tunnel graph

```
┌─researcher─┐     ┌──coder──┐
│ ● alive    │────►│ ● working│
│ 3 tasks    │     │ 1 tool   │
└────────────┘     └────┬─────┘
                        │
                   ┌────┴─────┐
                   │ tunnel   │
                   │ local    │
                   │ ● online │
                   └──────────┘
```

**2. Agent view** — live ReAct loop

- Tree of iterations, LLM calls, and tool calls
- Tokens, costs, and latency
- Expandable message content

**3. Metrics view** — time-series charts

- Tokens per hour by agent
- Cumulative cost
- p50/p95 latency
- Tool success rate

**4. A2A view** — task flow between agents

- In-progress, completed, and failed tasks
- Dependency graph

### Relationship to OTEL

The OTEL spans that already exist (`spanAgentLoop`, `spanLLMCall`,
`spanToolCall`) can be exported to an OTEL backend such as Grafana or Jaeger.
The Fresh dashboard is complementary: it shows live state through KV watch,
while OTEL provides historical traces.

```
Real time : KV Watch → Fresh Dashboard
History   : OTEL spans → Grafana / Jaeger
```

## Modules to create

| Module                         | Role                                         |
| ------------------------------ | -------------------------------------------- |
| `src/telemetry/traces.ts`      | Write detailed traces into KV                |
| `web/routes/index.tsx`         | Main dashboard (Fresh)                       |
| `web/routes/agents/[id].tsx`   | Detailed agent view                          |
| `web/routes/network.tsx`       | Network view (graph)                         |
| `web/routes/api/watch.ts`      | SSE endpoint that exposes KV watch to the UI |
| `web/islands/AgentTrace.tsx`   | Interactive trace-tree component             |
| `web/islands/NetworkGraph.tsx` | Interactive network graph                    |

## Consequences

- Detailed traces consume KV space, so they need a TTL and cleanup (delete
  traces older than 24h)
- The Fresh dashboard is optional; the broker still works without it
- Every `AgentRuntime` must write traces into KV (added in the agent loop)
- This is similar to OpenClaw tool-call tracing, but deeper: every ReAct-loop
  iteration becomes visible
