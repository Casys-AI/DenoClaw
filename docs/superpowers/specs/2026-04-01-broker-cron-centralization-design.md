# Broker Cron Centralization

**Date:** 2026-04-01
**Status:** Approved

## Goal

Move cron scheduling from the agent runtime to the broker. Agents become purely
reactive — they receive cron-triggered work as normal A2A tasks. The broker owns
the cron registry, fires jobs via `Deno.cron`, and dispatches `task_submit` to
the target agent.

## Context

Today `CronManager` lives in `src/agent/cron.ts`. Each `AgentRuntime` opens KV,
registers a `Deno.cron` heartbeat, and writes its own status. This is
inconsistent with the broker-as-control-plane principle: the broker already owns
ingress, routing, sandbox, and privilege elevation.

The `CronJob` type already carries a `task` field (the prompt/action), but only
`"heartbeat"` is ever registered. The infrastructure exists for user-defined
scheduled tasks but is stuck agent-side.

## Design

### BrokerCronManager

New module in `src/orchestration/broker/cron_manager.ts`.

Responsibilities:
- Persist cron jobs in KV at `["cron", agentId, jobId]`
- Register `Deno.cron` handlers for each active job
- On cron fire: dispatch a `task_submit` to the target agent with the job's
  prompt as message content and cron metadata (`cronJobId`, `cronName`) in the
  task metadata
- On broker boot: reload all persisted cron jobs from KV and re-register them
  with `Deno.cron`
- Manage job lifecycle: create, list, delete, enable/disable

### BrokerCronJob type

```typescript
interface BrokerCronJob {
  id: string;
  agentId: string;
  name: string;
  schedule: string; // cron expression
  prompt: string;   // what the agent should do when the cron fires
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}
```

### Agent-facing tools

Three broker-backed tools, dispatched through the existing `ToolExecutionPort`:

| Tool | Purpose | Parameters |
|------|---------|------------|
| `create_cron` | Register a scheduled task | `name`, `schedule`, `prompt` |
| `list_crons` | List the agent's cron jobs | none |
| `delete_cron` | Remove a cron job | `cronJobId` |

These tools are scoped to the calling agent's `agentId`. An agent cannot
create or delete crons for another agent.

Flow:
```
Agent LLM decides to call create_cron
  -> tool_request to broker
    -> BrokerCronManager.create(agentId, name, schedule, prompt)
      -> persists to KV + registers Deno.cron
        -> tool_response { id, created: true }
```

### Cron execution flow

```
Deno.cron fires in broker process
  -> BrokerCronManager reads the BrokerCronJob
    -> broker dispatches task_submit to the target agent:
       { message: job.prompt, metadata: { cronJobId, cronName, cronSchedule } }
      -> agent treats it as a normal task
        -> task_result flows back through normal A2A lifecycle
  -> BrokerCronManager updates job.lastRun
```

### Heartbeat

Heartbeat becomes a system-level cron managed by the broker, not a special case.

On agent registration or broker boot, the broker creates a heartbeat cron for
each known agent if one does not already exist. The heartbeat cron dispatches a
lightweight health-check task to the agent. The broker writes agent status
(`["agents", agentId, "status"]`) based on task_result success/failure/timeout.

Alternatively, the broker can derive liveness from existing signals (WebSocket
connection state, recent task completions) without dispatching a dedicated
heartbeat task. This is simpler and avoids unnecessary work. The broker already
knows which agents are connected.

Decision: **start with broker-derived liveness** (no heartbeat task dispatch).
The broker writes `"alive"` status based on recent task activity or active
WebSocket connection. Add a dedicated heartbeat cron later only if passive
liveness detection proves insufficient.

### What gets removed from agent

- `src/agent/cron.ts` — deleted entirely
- `AgentRuntime.start()` — no longer registers `Deno.cron`, no longer opens KV
  for heartbeat status writes
- `AgentRuntime.stop()` — no longer calls `cron.close()`
- `CronJob` type in `src/agent/types.ts` — removed (replaced by
  `BrokerCronJob` in broker types)
- `CronManager` import/usage in `src/agent/runtime.ts` — removed

### What gets added to broker

- `src/orchestration/broker/cron_manager.ts` — `BrokerCronManager` class
- `src/orchestration/broker/cron_manager_test.ts` — tests
- Cron tool definitions registered in broker tool dispatch
- `BrokerCronJob` type in broker types
- Cron job reload in broker bootstrap/startup
- Agent liveness tracking in broker (replaces agent-side heartbeat writes)

### KV key layout

| Key | Value | Owner |
|-----|-------|-------|
| `["cron", agentId, jobId]` | `BrokerCronJob` | BrokerCronManager |
| `["agents", agentId, "status"]` | `AgentStatusValue` | Broker (liveness) |

The `["cron", jobId]` flat layout used today is replaced by
`["cron", agentId, jobId]` so cron jobs are naturally scoped per agent and
listable by agent prefix.

### Dashboard

The existing `/cron/jobs` monitoring endpoint (`listCronJobs` in
`monitoring.ts`) continues to work — it reads from the same KV prefix. The key
layout change from `["cron", jobId]` to `["cron", agentId, jobId]` requires
updating the list prefix to `["cron"]` (still works) or adding per-agent
listing.

### Constraints

- **No broker = no crons.** This is consistent with the architecture: broker is
  required for all runtime features (sandbox, privilege elevation, routing).
- **`Deno.cron` lives in the broker process.** All scheduled jobs run in the
  broker's process. This is fine for the expected scale (tens of crons, not
  thousands).
- **`Deno.cron` has no cancel API.** Disabled jobs are skipped at fire time
  (check `job.enabled` in the handler), same as today. Deleted jobs are removed
  from the registry and their handler becomes a no-op.
- **Deploy compatibility.** `Deno.cron` is supported natively on Deno Deploy.
  The broker runs continuously on Deploy. No issues.
- **Local dev (`denoclaw dev`).** The broker is embedded in the gateway process.
  Crons fire in the same process. Works identically.

## Non-goals

- Cron execution history / audit log (future)
- Cron result routing to a specific channel (future)
- Cross-agent cron visibility (future)
- Cron rate limiting or quota per agent (future)

## Success criteria

- Agent can create a cron via conversation ("remind me every morning at 8")
- Cron fires and agent receives a normal task with the prompt
- Agent liveness is tracked by the broker without agent-side KV writes
- `src/agent/cron.ts` is deleted
- `AgentRuntime` no longer opens KV for heartbeat
- Dashboard shows cron jobs
- Tests cover: create/list/delete, cron fire dispatches task, disabled job
  skipped, broker boot reloads persisted jobs
