# ADR-013: Observability — Deploy OTEL + KV + Prisma Postgres

**Status:** Accepted **Date:** 2026-03-29 **Related:** ADR-011, ADR-012

## Context

DenoClaw needs observability across broker, agents, and relay. Three concerns:

1. **Real-time** — dashboard live, agent status, active tasks
2. **Debug** — trace spans across agent chains (who called who, latency)
3. **Historical** — metrics over time, error trends, token consumption,
   conversation history

## Decision

Three complementary storage layers, all provisionable on Deno Deploy:

### 1. Deno Deploy Native OTEL (auto-instrumented, zero config)

Deploy auto-instruments and stores logs, traces, and metrics:

| Signal  | Auto-captured                    | Retention (free) | Retention (pro) |
| ------- | -------------------------------- | ---------------- | --------------- |
| Logs    | console.log/error/warn           | 1 day            | 2 weeks         |
| Traces  | HTTP in/out, fetch, custom spans | 30 days          | 3 months        |
| Metrics | Request count, errors, latency   | 30 days          | 3 months        |

Custom spans via `@opentelemetry/api` (already in `src/telemetry/mod.ts`) are
automatically captured on Deploy. No `OTEL_DENO=1` needed — instrumentation is
always on.

### 2. Deno KV (real-time state, dashboard)

`TraceWriter` writes spans to the shared KV. Used by the custom dashboard for
live visualization.

| Key pattern                           | Content                                 |
| ------------------------------------- | --------------------------------------- |
| `["traces", traceId]`                 | Trace root (agentId, sessionId, taskId) |
| `["traces", traceId, "span", spanId]` | Individual span                         |
| `["agents", agentId, "active_task"]`  | Current task                            |
| `["task_observations", taskId]`       | Recent task observation record          |
| `["_dashboard", ...]`                 | SSE watch sentinels                     |

KV is provisioned on Deploy via:

```bash
deno deploy database provision denoclaw-kv --kind denokv --org casys
```

Accessible from local via KV Connect:

```typescript
const kv = await Deno.openKv("https://api.deno.com/databases/<id>/connect");
```

### 3. Prisma Postgres (historical analytics, conversations)

Postgres managed by Prisma, provisioned directly on Deploy:

```bash
deno deploy database provision denoclaw-db --kind prisma --region us-east-1 --org casys
deno deploy database assign denoclaw-db --app denoclaw-broker --org casys
```

Used for data that needs querying, aggregation, and long-term retention:

| Table               | Content                                                |
| ------------------- | ------------------------------------------------------ |
| `conversations`     | Full conversation history per agent/session            |
| `llm_calls`         | Token usage, model, latency, cost per call             |
| `tool_executions`   | Tool name, args, success/failure, duration             |
| `task_observations` | Recent task observation stream for dashboard/debugging |
| `daily_metrics`     | Aggregated daily stats per agent                       |

ORM setup:

- Prisma ORM 7 with `runtime = "deno"` in schema
- `@prisma/adapter-pg` for Deploy compatibility
- Same `DATABASE_URL` works locally (Docker Postgres) and on Deploy (Prisma
  Postgres)

### Storage responsibility split

| Concern                    | Storage           | Why                        |
| -------------------------- | ----------------- | -------------------------- |
| Agent status, active tasks | KV                | Real-time, SSE-watchable   |
| Recent trace spans         | KV (with 24h TTL) | Dashboard live view        |
| Dashboard SSE sentinels    | KV                | Watch key changes          |
| OTEL traces/metrics        | Deploy native     | Zero config, 30d retention |
| Conversation history       | Prisma Postgres   | Queryable, durable         |
| Token/cost analytics       | Prisma Postgres   | Aggregation, GROUP BY      |
| Tool execution logs        | Prisma Postgres   | Searchable, filterable     |
| Task lifecycle history     | Prisma Postgres   | Long-term audit trail      |

## Infrastructure

```
Local dev:
  KV  → ./data/shared.db (file)
  SQL → Postgres via Docker (docker compose up)

Deploy:
  KV  → deno deploy database (--kind denokv)
  SQL → deno deploy database (--kind prisma)

Both accessible via:
  KV  → Deno.openKv() or KV Connect URL
  SQL → DATABASE_URL (same Prisma client)
```

## Consequences

**Positive:**

- All storage provisionable via `deno deploy database` CLI
- Same code runs locally (Docker Postgres) and on Deploy (Prisma Postgres)
- KV for hot data, SQL for cold data — each used for what it's best at
- Dashboard can show real-time (KV) and historical (SQL) in one UI
- OTEL covers production debugging without any custom code

**Negative:**

- Two databases to manage (KV + Postgres)
- Prisma adds a build step (`prisma generate`) to the Deploy pipeline
- Prisma Postgres pricing is usage-based (no confirmed free tier)
- Docker required for local Postgres development

## Future work

- Add `expireIn: 86400000` (24h TTL) to KV trace writes
- Prisma schema and migrations for the tables above
- Dashboard SQL views (token costs, error rates, conversation browser)
- Consider connection pooling for high-traffic Deploy scenarios
