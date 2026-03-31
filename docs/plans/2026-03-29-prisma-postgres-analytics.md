# Plan: Prisma Postgres Analytics + Dashboard Integration

**Goal:** Add persistent SQL storage for historical analytics, conversation
history, and dashboard stats. KV stays for real-time; Prisma Postgres handles
queryable historical data.

---

## Phase 1 — Prisma Setup

### Task 1.1: Add Prisma dependencies and schema

**Files:**

- Modify: `deno.json` (add prisma imports)
- Create: `prisma/schema.prisma`
- Create: `src/db/client.ts` (Prisma client singleton)
- Create: `docker-compose.yml` (local Postgres)

**Schema:**

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

model Conversation {
  id        String   @id @default(uuid())
  agentId   String
  sessionId String
  role      String   // user | assistant | tool
  content   String
  toolName  String?
  toolCallId String?
  createdAt DateTime @default(now())

  @@index([agentId, sessionId])
  @@index([createdAt])
}

model LlmCall {
  id               String   @id @default(uuid())
  agentId          String
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
  id        String   @id @default(uuid())
  agentId   String
  taskId    String?
  toolName  String
  success   Boolean
  durationMs Int
  errorCode String?
  createdAt DateTime @default(now())

  @@index([agentId, toolName])
  @@index([createdAt])
}

model AgentTask {
  id          String   @id
  contextId   String?
  fromAgent   String
  targetAgent String
  state       String   // SUBMITTED | WORKING | COMPLETED | FAILED | REJECTED | CANCELED
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  completedAt DateTime?

  @@index([fromAgent])
  @@index([targetAgent])
  @@index([state])
  @@index([createdAt])
}

model DailyMetrics {
  id               String   @id @default(uuid())
  agentId          String
  date             DateTime @db.Date
  totalLlmCalls    Int      @default(0)
  totalTokens      Int      @default(0)
  totalToolCalls   Int      @default(0)
  totalTasks       Int      @default(0)
  errorCount       Int      @default(0)
  avgLatencyMs     Int      @default(0)

  @@unique([agentId, date])
  @@index([date])
}
```

**docker-compose.yml:**

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

**deno.json imports:**

```json
"@prisma/client": "npm:@prisma/client@^7",
"@prisma/adapter-pg": "npm:@prisma/adapter-pg@^7",
"prisma": "npm:prisma@^7"
```

**deno.json tasks:**

```json
"db:generate": "deno run -A npm:prisma generate",
"db:push": "deno run -A npm:prisma db push",
"db:migrate": "deno run -A npm:prisma migrate dev",
"db:studio": "deno run -A npm:prisma studio"
```

### Task 1.2: Create Prisma client singleton

**File:** `src/db/client.ts`

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

---

## Phase 2 — Write Hooks (record data to Postgres)

### Task 2.1: Record LLM calls

**File:** Modify `src/orchestration/broker.ts` (handleLLMRequest)

After a successful LLM call, write to Postgres:

```typescript
await getDb().llmCall.create({
  data: {
    agentId: msg.from,
    model,
    provider,
    promptTokens,
    completionTokens,
    latencyMs,
  },
});
```

Optional: wrap in try/catch — SQL write failure should not block the LLM
response.

### Task 2.2: Record tool executions

**File:** Modify `src/orchestration/broker.ts` (handleToolRequest)

After tool execution:

```typescript
await getDb().toolExecution.create({
  data: { agentId: msg.from, toolName, success, durationMs, errorCode },
});
```

### Task 2.3: Record task lifecycle

**File:** Modify `src/orchestration/broker.ts` (submitAgentTask,
recordTaskResult)

On task submit → create row. On task result → update state + completedAt.

### Task 2.4: Record conversations

**File:** Modify `src/agent/runtime.ts` or `src/agent/loop.ts`

Each `memory.addMessage()` also writes to Postgres. Or: batch-write at the end
of a conversation turn.

---

## Phase 3 — Dashboard Integration (read from Postgres)

### Task 3.1: API endpoints for analytics

**File:** Modify `src/orchestration/gateway.ts`

Add REST endpoints:

- `GET /api/stats/overview` — total LLM calls, tokens, tasks today/week/month
- `GET /api/stats/agent/:id` — per-agent stats (calls, tokens, errors, avg
  latency)
- `GET /api/stats/daily` — daily metrics time series (for charts)
- `GET /api/conversations/:agentId` — conversation history browser
- `GET /api/tasks/history` — task lifecycle history with filtering

### Task 3.2: Dashboard UI for stats

**Files:** `web/` components

- Overview page: token consumption chart, task success rate, agent activity
- Agent detail: conversation browser, tool usage breakdown, error log
- Cost tracker: tokens × model pricing, daily/weekly totals

### Task 3.3: Aggregation cron

**File:** Create `src/db/aggregate.ts`

Daily cron job (`Deno.cron`) that:

1. Reads LlmCall/ToolExecution/AgentTask from last 24h
2. Aggregates into DailyMetrics row
3. Optionally prunes raw data older than 30 days

---

## Phase 4 — Deploy Provisioning

### Task 4.1: Provision Prisma Postgres on Deploy

```bash
deno deploy database provision denoclaw-db --kind prisma --region us-east-1 --org casys
deno deploy database assign denoclaw-db --app denoclaw-broker --org casys
```

### Task 4.2: Run migrations on Deploy

Build command in Deploy dashboard:

```
deno run -A npm:prisma migrate deploy
```

### Task 4.3: Set DATABASE_URL

```bash
deno deploy env set DATABASE_URL="prisma+postgres://..." --app denoclaw-broker --org casys
```

---

## Dependencies

- Phase 1 has no blockers
- Phase 2 depends on Phase 1 (schema must exist)
- Phase 3 depends on Phase 2 (data must be written before it can be read)
- Phase 4 can run in parallel with Phase 2-3 (provisioning is independent)

## Non-goals

- No real-time streaming from Postgres (KV + SSE handles that)
- No complex BI dashboards (Deploy OTEL dashboard covers production debugging)
- No data warehouse / OLAP — this is operational analytics only
