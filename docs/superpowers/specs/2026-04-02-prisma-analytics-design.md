# Prisma Analytics — Persistent Historical Analytics for DenoClaw

Date: 2026-04-02
Status: design approved

## Summary

Add Prisma/Postgres as a persistent analytics layer complementing the existing
Deno KV real-time metrics. A Kaku `analyticsMiddleware` captures LLM calls, tool
executions, and conversations from the agent pipeline. Broker hooks capture A2A
task lifecycle. A daily cron aggregates `DailyMetrics`. Three missing dashboard
endpoints are implemented against Postgres.

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| KV strategy | Dual-write (KV + Postgres coexist) | KV for real-time (SSE, atomic counters), Postgres for history. No migration risk. |
| Write location | analyticsMiddleware (Kaku) + broker hooks | Middleware covers 90% (LLM, tools, conversations). Broker adds task lifecycle. |
| Schema model | Specialized tables (not event-centric) | Direct SQL queries for dashboard, no JSON parsing overhead |
| Write strategy | Fire-and-forget | No latency added to agent execution. Consistent with existing trace pattern. |
| pgvector | Not in this iteration | Reserved for sub-project B (Mastra memory) |

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Pipeline (Kaku)                 │
│  observability → memory → contextRefresh → analytics    │
│                    → a2a → tool → llm                   │
└───────────────────────────┬─────────────────────────────┘
                            │ fire-and-forget writes
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    Postgres (Prisma)                     │
│  LlmCall │ ToolExecution │ Conversation │ AgentTask     │
│                   DailyMetrics                          │
└───────────────────────────┬─────────────────────────────┘
                            │ SQL queries
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Dashboard API (gateway routes)              │
│  /stats/tools  │  /stats/history  │  /agents/:id/traces │
└─────────────────────────────────────────────────────────┘

KV (unchanged): MetricsCollector, TraceWriter, SSE, agent status
```

The analyticsMiddleware is added to both `createLocalRunner` and
`createBrokerRunner` pipelines. It observes events without resolving them
(same pattern as memoryMiddleware).

## Schema

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/db/generated"
  runtime  = "deno"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model LlmCall {
  id               String   @id @default(uuid())
  agentId          String
  sessionId        String?
  taskId           String?
  model            String
  provider         String
  promptTokens     Int
  completionTokens Int
  latencyMs        Int
  createdAt        DateTime @default(now())

  @@index([agentId])
  @@index([model])
  @@index([createdAt])
}

model ToolExecution {
  id         String   @id @default(uuid())
  agentId    String
  sessionId  String?
  taskId     String?
  toolName   String
  success    Boolean
  durationMs Int
  errorCode  String?
  createdAt  DateTime @default(now())

  @@index([agentId, toolName])
  @@index([createdAt])
}

model Conversation {
  id         String   @id @default(uuid())
  agentId    String
  sessionId  String
  role       String
  content    String
  toolName   String?
  toolCallId String?
  createdAt  DateTime @default(now())

  @@index([agentId, sessionId])
  @@index([createdAt])
}

model AgentTask {
  id          String    @id
  contextId   String?
  fromAgent   String
  targetAgent String
  state       String
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  completedAt DateTime?

  @@index([fromAgent])
  @@index([targetAgent])
  @@index([state])
  @@index([createdAt])
}

model DailyMetrics {
  id             String   @id @default(uuid())
  agentId        String
  date           DateTime @db.Date
  totalLlmCalls  Int      @default(0)
  totalTokens    Int      @default(0)
  totalToolCalls Int      @default(0)
  totalTasks     Int      @default(0)
  errorCount     Int      @default(0)
  avgLatencyMs   Int      @default(0)

  @@unique([agentId, date])
  @@index([date])
}
```

## analyticsMiddleware (Kaku pipeline)

### Position in pipeline

```typescript
// Local runner
pipeline
  .use(observabilityMiddleware(deps.observability))
  .use(memoryMiddleware(deps.memory))
  .use(contextRefreshMiddleware(deps.contextRefresh))
  .use(analyticsMiddleware(deps.analytics))  // NEW
  .use(toolMiddleware(deps.executeTool))
  .use(llmMiddleware(...))

// Broker runner
pipeline
  .use(memoryMiddleware(deps.memory))
  .use(contextRefreshMiddleware(deps.contextRefresh))
  .use(analyticsMiddleware(deps.analytics))  // NEW
  .use(a2aTaskMiddleware(deps.a2aTask))
  .use(toolMiddleware(deps.executeTool))
  .use(llmMiddleware(...))
```

Placed after contextRefresh and before tool/llm — it observes resolved events
on the way back up the onion (post-execution timing is accurate).

### Event handling

```typescript
interface AnalyticsDeps {
  agentId: string;
  sessionId: string;
}

function analyticsMiddleware(deps: AnalyticsDeps): Middleware {
  return async (ctx, next) => {
    const resolution = await next();

    // LLM response — record call metrics
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      const model = /* captured from prior llm_request */ "";
      getDb().llmCall.create({
        data: {
          agentId: deps.agentId,
          sessionId: deps.sessionId,
          model,
          provider: model.split("/")[0],
          promptTokens: e.usage?.promptTokens ?? 0,
          completionTokens: e.usage?.completionTokens ?? 0,
          latencyMs: 0, // computed from timing
        },
      }).catch((err) => log.warn("analytics: failed to record LLM call", err));
    }

    // Tool result — record execution
    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      getDb().toolExecution.create({
        data: {
          agentId: deps.agentId,
          sessionId: deps.sessionId,
          toolName: e.name,
          success: e.result.success,
          durationMs: 0, // computed from timing
          errorCode: e.result.error?.code,
        },
      }).catch((err) => log.warn("analytics: failed to record tool execution", err));
    }

    // Conversation messages (llm_response + tool_result)
    if (ctx.event.type === "llm_response") {
      const e = ctx.event as LlmResponseEvent;
      getDb().conversation.create({
        data: {
          agentId: deps.agentId,
          sessionId: deps.sessionId,
          role: "assistant",
          content: e.content,
        },
      }).catch((err) => log.warn("analytics: failed to record conversation", err));
    }

    if (ctx.event.type === "tool_result") {
      const e = ctx.event as ToolResultEvent;
      getDb().conversation.create({
        data: {
          agentId: deps.agentId,
          sessionId: deps.sessionId,
          role: "tool",
          content: formatToolResultContent(e.result),
          toolName: e.name,
          toolCallId: e.callId,
        },
      }).catch((err) => log.warn("analytics: failed to record conversation", err));
    }

    return resolution;
  };
}
```

### Timing capture

The middleware needs LLM latency and tool duration. Two approaches:

1. **Read from observabilityMiddleware via session state** — but observability
   keeps timing in private closures.
2. **Track timing independently** — the analyticsMiddleware wraps `next()` for
   `llm_request` and `tool_call` events to capture start/end timestamps.

Approach 2 is cleaner (no coupling to observability). The middleware captures
timing when it sees the request event, and uses it when it sees the response
observation:

```typescript
let llmStart = 0;
const toolStarts = new Map<string, number>();

// On llm_request: llmStart = performance.now()
// On llm_response: latencyMs = performance.now() - llmStart
// On tool_call: toolStarts.set(callId, performance.now())
// On tool_result: durationMs = performance.now() - toolStarts.get(callId)
```

### Model capture

The LLM model name is available in `llm_request.config.model` but not in
`llm_response`. Same pattern as observabilityMiddleware — capture on request,
use on response:

```typescript
let lastModel = "";
// On llm_request: lastModel = event.config.model
// On llm_response: use lastModel for the db write
```

## Broker hooks (task lifecycle)

### File: `src/orchestration/broker/analytics_hooks.ts`

```typescript
import { getDb } from "../../db/client.ts";
import { log } from "../../shared/log.ts";

export function recordTaskSubmission(
  taskId: string, contextId: string | undefined,
  fromAgent: string, targetAgent: string,
): void {
  getDb().agentTask.create({
    data: { id: taskId, contextId, fromAgent, targetAgent, state: "SUBMITTED" },
  }).catch((err) => log.warn("analytics: failed to record task submission", err));
}

export function recordTaskResult(
  taskId: string, state: string,
): void {
  getDb().agentTask.update({
    where: { id: taskId },
    data: {
      state,
      ...(isTerminalState(state) ? { completedAt: new Date() } : {}),
    },
  }).catch((err) => log.warn("analytics: failed to record task result", err));
}

function isTerminalState(state: string): boolean {
  return ["COMPLETED", "FAILED", "CANCELED", "REJECTED"].includes(state);
}
```

Called from `broker.ts`:
- `submitAgentTask()` → `recordTaskSubmission(taskId, contextId, from, to)`
- `recordTaskResult()` → `recordTaskResult(taskId, state)`

## Daily aggregation cron

### File: `src/db/aggregate.ts`

A `Deno.cron` job running daily that:

1. Reads yesterday's `LlmCall`, `ToolExecution`, `AgentTask` rows
2. Aggregates per-agent into `DailyMetrics` (upsert)
3. No data pruning in v1 (can add later with retention policy)

```typescript
Deno.cron("daily-metrics-aggregation", "0 2 * * *", async () => {
  const yesterday = startOfYesterday();
  const today = startOfToday();
  const db = getDb();

  const agents = await db.llmCall.findMany({
    where: { createdAt: { gte: yesterday, lt: today } },
    distinct: ["agentId"],
    select: { agentId: true },
  });

  for (const { agentId } of agents) {
    const llm = await db.llmCall.aggregate({
      where: { agentId, createdAt: { gte: yesterday, lt: today } },
      _count: true,
      _sum: { promptTokens: true, completionTokens: true, latencyMs: true },
    });
    const tools = await db.toolExecution.aggregate({
      where: { agentId, createdAt: { gte: yesterday, lt: today } },
      _count: true,
    });
    const tasks = await db.agentTask.count({
      where: { targetAgent: agentId, createdAt: { gte: yesterday, lt: today } },
    });
    const errors = await db.toolExecution.count({
      where: { agentId, success: false, createdAt: { gte: yesterday, lt: today } },
    });

    await db.dailyMetrics.upsert({
      where: { agentId_date: { agentId, date: yesterday } },
      create: {
        agentId,
        date: yesterday,
        totalLlmCalls: llm._count,
        totalTokens: (llm._sum.promptTokens ?? 0) + (llm._sum.completionTokens ?? 0),
        totalToolCalls: tools._count,
        totalTasks: tasks,
        errorCount: errors,
        avgLatencyMs: llm._count > 0
          ? Math.round((llm._sum.latencyMs ?? 0) / llm._count)
          : 0,
      },
      update: {}, // no-op if already computed
    });
  }
});
```

## Dashboard endpoints

### File: `src/orchestration/gateway/analytics_routes.ts`

Three new routes registered in the gateway HTTP router.

#### GET /stats/tools?agent=

```typescript
const rows = await getDb().toolExecution.groupBy({
  by: ["toolName"],
  where: { agentId: agent },
  _count: true,
  _sum: { durationMs: true },
  _avg: { durationMs: true },
});
// Also compute successes/failures per tool
```

Returns: `{ tools: [{ name, calls, successes, failures, avgLatencyMs }] }`

#### GET /stats/history?agent=&from=&to=

```typescript
const rows = await getDb().dailyMetrics.findMany({
  where: { agentId: agent, date: { gte: from, lte: to } },
  orderBy: { date: "asc" },
});
```

Returns: `{ metrics: [{ date, totalLlmCalls, totalTokens, ... }] }`

#### GET /agents/:id/traces

Returns historical LLM calls (complements KV traces which have 24h TTL):

```typescript
const rows = await getDb().llmCall.findMany({
  where: { agentId: id },
  orderBy: { createdAt: "desc" },
  take: limit,
});
```

Returns: `{ calls: [{ model, tokens, latencyMs, createdAt }] }`

## Infrastructure

### docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: denoclaw
      POSTGRES_USER: denoclaw
      POSTGRES_PASSWORD: denoclaw
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### deno.json additions

```json
// imports
"@prisma/client": "npm:@prisma/client@^7",
"@prisma/adapter-pg": "npm:@prisma/adapter-pg@^7"

// tasks
"db:generate": "deno run -A npm:prisma generate",
"db:push": "deno run -A npm:prisma db push",
"db:migrate": "deno run -A npm:prisma migrate dev",
"db:studio": "deno run -A npm:prisma studio"
```

### Prisma client singleton (`src/db/client.ts`)

```typescript
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!prisma) {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL not set");
    const adapter = new PrismaPg({ connectionString: url });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

export async function closeDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
```

### Conditional activation

The analytics layer is opt-in via `DATABASE_URL`:
- If `DATABASE_URL` is set → analyticsMiddleware writes to Postgres
- If not set → analyticsMiddleware is a no-op (not added to pipeline)
- KV metrics continue regardless

This keeps the local dev experience unchanged (no Postgres required).

## New files

| File | Content |
|---|---|
| `prisma/schema.prisma` | Schema with 5 models |
| `docker-compose.yml` | Local Postgres 17 |
| `src/db/client.ts` | PrismaClient singleton |
| `src/agent/middlewares/analytics.ts` | Kaku analyticsMiddleware |
| `src/agent/middlewares/analytics_test.ts` | Middleware tests |
| `src/orchestration/broker/analytics_hooks.ts` | Task lifecycle hooks |
| `src/orchestration/gateway/analytics_routes.ts` | 3 dashboard endpoints |
| `src/db/aggregate.ts` | Daily metrics cron |

## Modified files

| File | Change |
|---|---|
| `deno.json` | Prisma imports + db tasks |
| `src/agent/runner.ts` | Add analytics deps to factory interfaces, wire middleware |
| `src/orchestration/broker/broker.ts` | Call analytics hooks on task submit/result |
| `src/orchestration/gateway/http_routes.ts` | Register analytics routes |

## What does NOT change

- `MetricsCollector` (KV) — intact
- `TraceWriter` (KV) — intact
- `memoryMiddleware` — intact
- `observabilityMiddleware` — intact
- SSE live feed — intact
- Agent execution — no latency added (fire-and-forget)
- Local dev without Postgres — unchanged (DATABASE_URL opt-in)

## Deploy provisioning

Integrated into the existing `deno task deploy` → `deployBroker()` flow in
`src/cli/setup/broker_deploy.ts`, following the same pattern as KV provisioning.

### Naming convention

Add to `src/shared/naming.ts`:

```typescript
export function deriveBrokerPrismaName(
  appName = deriveBrokerAppName(),
): string {
  return `${normalizeDeploySlug(appName)}-db`;
}
```

Result: `denoclaw-broker-db` (follows existing `denoclaw-broker-kv` pattern).

### Deploy flow addition

Add `ensureBrokerPrismaDatabase()` in `broker_deploy.ts`, called right after
`ensureBrokerKvDatabase()` inside `deployBroker()`:

```typescript
async function ensureBrokerPrismaDatabase(): Promise<void> {
  const prismaDatabase = deriveBrokerPrismaName(app);
  print(`Ensuring Prisma Postgres database ${prismaDatabase}...`);

  const provisionResult = await runDeployCli([
    "deploy", "database", "provision", prismaDatabase,
    "--kind", "prisma",
    "--region", region,  // uses the same --region as the app
    "--org", org,
  ]);
  if (!provisionResult.success) {
    const output = `${provisionResult.stdout}\n${provisionResult.stderr}`;
    if (!output.includes("already in use")) {
      throw new Error(`failed to provision Prisma database: ${output.trim()}`);
    }
  }

  const assignResult = await runDeployCli([
    "deploy", "database", "assign", prismaDatabase,
    "--org", org, "--app", app,
  ]);
  if (!assignResult.success) {
    const output = `${assignResult.stdout}\n${assignResult.stderr}`;
    if (!output.includes("already")) {
      throw new Error(`failed to assign Prisma database: ${output.trim()}`);
    }
  }

  success(`Prisma database ${prismaDatabase} assigned to ${app}`);
  // DATABASE_URL is auto-injected by Deno Deploy after assign
}
```

### Migration at deploy time

Prisma migrations run as part of the deploy build step. The build command in
the Deploy app config should include:

```typescript
const brokerAppConfig = {
  install: "true",
  build: "true",
  predeploy: "deno run -A npm:prisma migrate deploy",
  // ...existing config
};
```

### Config persistence

Store the Prisma database name alongside the KV name:

```typescript
config.deploy = {
  org, app, region,
  kvDatabase,
  prismaDatabase,  // NEW
  url: deployedUrl,
};
```

### Modified files for deploy

| File | Change |
|---|---|
| `src/shared/naming.ts` | Add `deriveBrokerPrismaName()` |
| `src/cli/setup/broker_deploy.ts` | Add `ensureBrokerPrismaDatabase()` in deploy flow |
| `src/cli/setup/broker_deploy_naming.ts` | Add `prismaDatabase` to naming resolution |

### No separate command needed

The single `deno task deploy` command handles everything:
1. Create app (existing)
2. Provision + assign KV (existing)
3. **Provision + assign Prisma** (new)
4. Set env vars (existing)
5. Deploy with migrations (existing, add predeploy)

For local dev: `docker-compose up -d` + `deno task db:push` — no Deploy needed.

## Future extensions (not in this iteration)

- **pgvector + Mastra memory** — sub-project B, separate spec
- **Data retention** — prune raw data older than N days
- **Cost estimation** — multiply tokens by model pricing table
- **Replace KV metrics** — once Postgres is proven stable
