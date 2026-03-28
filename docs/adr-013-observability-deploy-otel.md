# ADR-013: Observability — Deploy Native OTEL + KV Traces

**Status:** Accepted
**Date:** 2026-03-29
**Related:** ADR-011, ADR-012

## Context

DenoClaw needs observability across broker, agents, and relay. Three concerns:

1. **Real-time** — dashboard live, agent status, active tasks
2. **Debug** — trace spans across agent chains (who called who, latency)
3. **Historical** — metrics over time, error trends, token consumption

## Decision

Use two complementary systems, no external database required:

### 1. Deno Deploy Native OTEL (production)

Deploy auto-instruments and stores logs, traces, and metrics with zero configuration:

| Signal | Auto-captured | Retention (free) | Retention (pro) |
|--------|---------------|-------------------|-----------------|
| Logs | console.log/error/warn | 1 day | 2 weeks |
| Traces | HTTP in/out, fetch, custom spans | 30 days | 3 months |
| Metrics | Request count, errors, latency | 30 days | 3 months |

Custom spans via `@opentelemetry/api` (already in `src/telemetry/mod.ts`) are automatically captured on Deploy. No `OTEL_DENO=1` needed on Deploy — instrumentation is always on.

Accessible via:
- Deploy dashboard (traces waterfall, metrics graphs, logs viewer)
- REST API: `GET /v2/apps/{app}/logs` (logs only)
- CLI: `deno deploy logs`

### 2. KV Traces (local + custom dashboard)

`TraceWriter` in `src/telemetry/traces.ts` writes spans to the shared KV (`data/shared.db`). Used by the custom dashboard for real-time visualization in local mode.

| Key pattern | Content |
|-------------|---------|
| `["traces", traceId]` | Trace root (agentId, sessionId, taskId) |
| `["traces", traceId, "span", spanId]` | Individual span |
| `["agents", agentId, "active_task"]` | Current task |
| `["agent_tasks", taskId]` | A2A task record |
| `["_dashboard", ...]` | SSE watch sentinels |

### Storage responsibility split

| Concern | Local mode | Deploy mode |
|---------|-----------|-------------|
| Real-time dashboard | KV shared (`data/shared.db`) | KV (platform) |
| Debug traces | KV traces + console | Deploy traces dashboard |
| Historical metrics | Not stored (dev only) | Deploy metrics (30d) |
| Logs | Console + LOG_LEVEL | Deploy logs + REST API |

## Consequences

**Positive:**
- Zero infrastructure for observability in production (Deploy does it all)
- Custom dashboard works locally with KV traces
- OTEL spans already instrumented (`withSpan`, `spanAgentLoop`, `spanToolCall`, `spanLLMCall`)
- No SQL database needed for observability

**Negative:**
- Traces/metrics not queryable via REST API on Deploy (dashboard only)
- Free tier retention is limited (1 day logs, 30 days metrics)
- No built-in aggregation (daily/weekly token costs, error rates by agent)
- KV traces in local mode accumulate without TTL (needs `expireIn` parameter)

## Future work

- Add `expireIn: 86400000` (24h TTL) to KV trace writes
- Aggregate token consumption metrics per agent per day in KV (hourly buckets)
- If historical analytics becomes critical, export OTEL to Grafana Cloud (free tier: 50GB traces) or self-hosted Postgres on VPS
- Consider libSQL (open source, Turso-compatible) as an edge-compatible SQL option if KV aggregation proves insufficient
