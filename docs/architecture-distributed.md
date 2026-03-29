# DenoClaw Distributed Architecture

## Core Principle

**The Broker orchestrates. The agent reacts. Code runs in Sandbox.**

**A2A over transport X, persisted in KV, correlated by task/context ids.**

The architecture has three layers, each with a distinct role (ADR-001):

- **Broker** (Deno Deploy) = central orchestrator (LLM proxy, cron, message
  routing, agent lifecycle). The only truly long-running component.
- **Subhosting** = the agent (warm-cached V8 isolates, KV-backed state and
  memory). It wakes on Broker HTTP and goes back to sleep when idle.
  **No `Deno.cron()`, no `listenQueue()`.**
- **Sandbox** = execution (ephemeral, hardened permissions, user
  skills/tools/LLM-generated code)

No code runs directly inside Subhosting. Everything goes through Sandbox with
locked-down permissions.

> **Subhosting API:** use **v2** (`api.deno.com/v2`). v1 is deprecated and
> sunsets in July 2026.

## Overview

```
┌─────────────────── DENO DEPLOY (Broker) ───────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────┐       │
│  │              LLM Gateway / Proxy                 │       │
│  │  API key mode: keys live on the broker → fetch() │       │
│  │  OAuth mode: OAuth token (browser flow)          │       │
│  │  Rate limiting, cost tracking, fallback, cache   │       │
│  └──────────────────────┬──────────────────────────┘       │
│                         │                                   │
│  ┌──────────────────────┴──────────────────────────┐       │
│  │               Message Router                     │       │
│  │  HTTP POST → Subhosting agents                   │       │
│  │  KV Queues = broker-internal durability          │       │
│  │  KV Watch = real-time observation                │       │
│  │  WebSocket hub = tunnel mesh                     │       │
│  └───┬──────────┬──────────┬──────────┬────────────┘       │
│      │          │          │          │                     │
│  ┌───┴──────┐  ┌──┴──────┐  ┌──┴──────┐  ┌──┴──────┐      │
│  │Subhost A │  │Subhost B │  │Subhost C │  │Subhost D │    │
│  │Agent 1   │  │Agent 2   │  │Agent 3   │  │Agent 4   │    │
│  │Private KV│  │Private KV│  │Private KV│  │Private KV│    │
│  │  ↓ exec  │  │  ↓ exec  │  │  ↓ exec  │  │  ↓ exec  │    │
│  │ Sandbox  │  │ Sandbox  │  │ Sandbox  │  │ Sandbox  │    │
│  │(hardened)│  │(hardened)│  │(hardened)│  │(hardened)│    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                                                             │
└──────────────┬────────────────────┬─────────────────────────┘
               │ WS tunnel          │ WS tunnel
               │                    │
        ┌──────┴──────┐      ┌─────┴──────┐
        │ Machine A    │      │ VPS / GPU   │
        │ Shell, FS    │      │ Specialized │
        │ Auth flow    │      │ tooling     │
        └─────────────┘      └────────────┘
```

## Components

### 1. Broker (Deno Deploy)

The Broker is the only component that runs outside Sandbox. It is the control
plane. It is responsible for:

- **LLM Proxy** — two auth modes, one final `fetch()` call (ADR-002):
  - **API key mode:** the broker holds provider keys (Anthropic, OpenAI, etc.)
  - **OAuth mode:** token acquired through a browser flow, same mechanism as
    Claude CLI / Codex CLI, stored on the Broker
  - The agent never knows which mode is in use. The interface stays uniform:
    `broker.complete()`
- **Message Router** — routes A2A tasks and messages to agents over HTTP POST.
  KV stores durable state and traces. Any KV Queue usage is just an internal
  broker optimization detail. The Broker also enforces A2A permissions.
- **Tunnel Hub** — Tailscale-like network mesh. Maintains WebSocket connections
  to nodes (machines, VPS, GPU hosts) and other Brokers (federation). Each
  tunnel declares its **capabilities** (tools, auth). The broker routes based
  on those declarations.
- **Cron Dispatcher** — one static `Deno.cron()` that reads agent schedules
  from KV and dispatches them over HTTP POST.
- **Agent Lifecycle** — creates, destroys, and monitors agents via the
  Subhosting **v2** API (Apps/Revisions) and Sandbox executions
  (ephemeral instances).
- **Auth** — `@deno/oidc` for Subhosting agents and tunnels. Credentials
  materialization for Sandboxes (ADR-003). The target is zero static secrets.

### 2. Agents (Deno Subhosting + Sandbox)

Each agent is one Subhosting deployment (warm-cached V8 isolate with bound KV).
Actual code execution happens inside ephemeral Sandboxes.

**Subhosting (reactive stateful endpoint):**

- Wakes on Broker HTTP POST and goes idle again afterward
- Has bound KV for memory and sessions, which persists independently of the isolate
- Receives messages from the Broker over HTTP, not KV Queues
  (`listenQueue` does not work in Subhosting)
- Requests LLM completions from the broker
- Dispatches code execution to Sandboxes
- Persists results in KV
- **Never** executes arbitrary code directly
- **No `Deno.cron()`** — scheduled work is managed by the Broker

**Sandbox (executor):**

- Ephemeral (30-minute max), created on demand
- Hardened permissions, broker-only network allowlist
- No secrets visible to the executed code
  (credentials materialization for broker auth, ADR-003)
- Executes user skills, tools, and LLM-generated code
- Returns the result and exits

```typescript
// Subhosting side — reactive agent runtime driven by Broker HTTP
class AgentRuntime {
  private broker: BrokerClient;
  private kv: Deno.Kv; // Bound KV, persistent memory survives isolate restarts

  // HTTP entry point — the Broker calls this endpoint
  async handleRequest(req: Request): Promise<Response> {
    const msg = await req.json() as BrokerMessage;

    if (msg.type === "user_message") return this.handleMessage(msg);
    if (msg.type === "cron_trigger") return this.handleCron(msg);
    // ... other Broker message types
  }

  async handleMessage(msg: Message): Promise<Response> {
    // LLM call through the broker
    const llmResponse = await this.broker.llmComplete({
      messages: await this.buildContext(msg),
      model: "anthropic/claude-sonnet-4-6",
    });

    // Tool call → execute in Sandbox through the broker
    if (llmResponse.toolCalls) {
      for (const tc of llmResponse.toolCalls) {
        const result = await this.broker.sandboxExec({
          tool: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        });
        await this.kv.set(["results", tc.id], result);
      }
    }

    return Response.json({ content: llmResponse.content });
  }
}
```

### 3. Tunnels (WebSocket)

The tunnel is DenoClaw's **network mesh**. It connects everything that is not
running on the same Deploy instance, similar to how Tailscale creates a private
network across machines.

#### Three connection types

| Type               | Connects                 | Usage                                                     |
| ------------------ | ------------------------ | --------------------------------------------------------- |
| **Node → Broker**  | Machine/VPS/GPU → Broker | Remote tools (shell, FS, GPU), browser-based OAuth auth   |
| **Broker → Broker** | Instance A ↔ Instance B | Cross-instance A2A federation                             |
| **Local → Broker** | Dev machine → Broker     | Local tools, auth flow, tests                             |

Agents are never directly attached to tunnels. They always go through their
Broker over HTTP.

```
Instance A                    Instance B                    Local machine
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Broker A │◄═══ tunnel ════►│ Broker B │                 │ denoclaw │
│  agents  │                 │  agents  │                 │ tunnel   │
└──────────┘                 └──────────┘                 └────┬─────┘
                                                               │
                              VPS (node)                       │
                             ┌──────────┐                      │
                             │ Shell/FS │◄══ tunnel ═══════════╝
                             │ GPU      │
                             └──────────┘
```

#### Commands

```bash
# Connect your local machine to the broker
denoclaw tunnel wss://my-broker.deno.dev/tunnel

# Connect two instances together
denoclaw tunnel wss://instance-a.deno.dev/tunnel
```

#### Current wire contract

Tunnel handshake is strict and versioned:

- auth through `Authorization: Bearer <invite-or-session-token>`
- mandatory subprotocol: `denoclaw.tunnel.v1`
- explicit `idleTimeout` on the broker side
- fail-fast rejection for saturated sockets instead of implicit buffering

Auth query parameters and handshakes without the expected subprotocol are not
part of the accepted `/tunnel` contract.

#### Capabilities

Each tunnel declares what it exposes:

```typescript
// VPS/machine node with tools
{
  tunnelType: "local",
  tools: ["shell", "fs_read", "fs_write"],
  agents: [],
  allowedAgents: ["planner", "operator"],
}

// Broker B (inter-instance federation)
{
  type: "instance",
  agents: ["support", "billing"], // agents routable through this tunnel
}

// Local development machine
{
  type: "local",
  tools: ["shell", "fs_read", "fs_write"],
  allowedAgents: ["planner", "operator"],
}
```

The broker maintains a registry of active tunnels and routes according to the
declared capabilities.

## Full message flow

```
1. User sends a message (Telegram, API, webhook)
           │
2. Broker receives it and creates/loads a session
           │
3. Broker sends the message to the agent over HTTP POST
           │  POST https://<agent>.deno.dev/ { type: "user_message", content: "..." }
           │
4. Subhosting agent wakes up (or is already warm) and processes the message
           │
5. Agent requests an LLM completion from the broker (HTTP fetch)
           │  POST https://<broker>/llm { model: "...", messages: [...] }
           │
6. Broker resolves the provider:
           │  ├─ model = "anthropic/..." → fetch() with API key (held by the broker)
           │  ├─ model = "openai/..."    → fetch() with API key
           │  └─ model = "claude-oauth"  → fetch() with OAuth token (from one-shot browser flow)
           │
7. Broker returns the LLM response in the HTTP response
           │
8. If there is a tool call, the agent asks the broker to execute it (HTTP fetch)
           │  POST https://<broker>/tool { tool: "shell", args: {...} }
           │
9. Broker routes to the right tunnel based on declared capabilities
           │  WebSocket: { tool: "shell", args: {...} }
           │
10. Local machine executes and sends the result back over WS
           │
11. Broker returns the result in the HTTP response
           │
12. Agent continues its loop (back to step 5) or responds
           │
13. Final response travels back through the Broker → user
```

**Cron / Heartbeat (Deploy mode):**

```
Broker (Deno.cron) → HTTP POST https://<agent>.deno.dev/cron/heartbeat → Agent wakes, runs, responds
```

## Tunnel capabilities

Each tunnel declares to the broker what it exposes:

```typescript
{
  tunnelId: "machine-erwan",
  tools: ["shell", "fs_read", "fs_write"],    // executable local tools
  allowedAgents: ["agent-123", "agent-456"],  // who is allowed to use it
}
```

The broker keeps a registry of active tunnels. When an agent requests a tool,
the broker looks up a tunnel that advertises that capability.

`BrokerClient` delegates to a pluggable `BrokerTransport` interface
(`KvQueueTransport` locally, HTTP/SSE on the network).

## LLM OAuth auth through a tunnel

When the Broker uses OAuth mode, similar to Claude CLI or Codex CLI, it needs a
browser for the initial authentication flow. The tunnel routes that URL to a
local machine:

1. Broker initiates an OAuth/device-code flow with the LLM provider
   (Anthropic, etc.)
2. It emits
   `{ type: "auth_request", url: "https://auth.anthropic.com/...", code: "ABCD-1234" }`
3. The tunnel routes the request to a local machine explicitly allowed for that flow
4. The local machine opens the browser with the URL
5. The user authenticates
6. The OAuth token travels back: tunnel → Broker
7. The Broker stores the token (KV or Secret Manager)

**This is a one-shot flow.** After the initial auth, the Broker uses the OAuth
token directly in its `fetch()` calls to the LLM API. No CLI is executed.

## Inter-agent communication

Agents never talk to each other directly because of network isolation.
Everything goes through the Broker over HTTP.

In other words: **A2A over HTTP + SSE, persisted in KV, correlated by
task/context ids.**

```typescript
// Agent A wants to delegate a task to Agent B — it submits a task to the Broker
await broker.submitTask({
  to: "agent-b",
  payload: { instruction: "Analyze this file", data: "..." },
});
// → The Broker routes a task_submit message to agent-b.deno.dev over HTTP POST

// Agent B receives it over HTTP (not listenQueue), processes it, continues or replies through the Broker
await broker.sendTextTask({
  to: "agent-a",
  text: "Analysis complete",
  payload: { analysis: "..." },
});
```

The broker checks **permissions**: is Agent A allowed to talk to Agent B?

## State observation (KV Watch)

The broker exposes agent state through KV. Any authorized component can watch it:

```typescript
// Dashboard or another agent watches state
for await (
  const entries of kv.watch([
    ["agents", "agent-a", "status"],
    ["agents", "agent-b", "status"],
  ])
) {
  // Real time: { task: "analyzing", progress: 0.7 }
}
```

## Security (see ADR-003)

Principle: **zero static secrets.** Everywhere.

| Boundary                          | Mechanism                                             | Static secret?                    |
| --------------------------------- | ----------------------------------------------------- | --------------------------------- |
| Sandbox isolation                 | Linux microVM, network allowlist                      | N/A                               |
| Agent (Subhosting) → Broker       | `@deno/oidc` (preferred), fallback Layers/invite      | No                                |
| Sandbox → Broker                  | Credentials materialization (token invisible to code) | No                                |
| Broker → Subhosting + Sandbox API | `@deno/oidc` (ephemeral token)                        | No                                |
| Tunnel → Broker                   | Ephemeral OIDC / one-time invite token                | No                                |
| Broker → LLM API                  | API key or OAuth token (one-shot browser flow)        | No (GCP Secret Manager, ADR-004)  |
| Inter-agents                      | Broker validates every message (`allowedPeers`)       | N/A                               |
| Transport                         | TLS (`wss://`) for all WebSocket links                | N/A                               |

## Advantages of the centralized LLM proxy

Sending **all** LLM calls through the broker gives:

- **Cost tracking** per agent / per user
- **Centralized rate limiting**
- **Fallback chains** (Anthropic down → switch to OpenAI)
- **Caching** for identical responses
- **Central logs** for all LLM calls
- **Provider switching** without changing agents

## Local mode vs Deploy

DenoClaw runs in both modes. The code is the same; only the environment changes.

|                           | Local mode                                             | Deploy mode                                       |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Broker / Main             | Main **Deno process**                                  | Deno Deploy                                       |
| Agent runtime             | **Worker** (one per agent)                             | Subhosting (warm-cached V8 isolate)               |
| Code execution            | **Subprocess** (`Deno.Command`)                        | Sandbox (microVM)                                 |
| Broker → Agent transport  | `postMessage` / `onmessage`                            | HTTP POST                                         |
| Agent → Sandbox transport | `Deno.Command` (spawn + stdin/stdout)                  | Sandbox API (HTTP)                                |
| KV                        | SQLite per agent (`Deno.openKv("./data/<agent>.db")`)  | FoundationDB (KV bound through API v2)            |
| Cron / Heartbeat          | Main process `Deno.cron()` → `postMessage` to Worker   | Broker `Deno.cron()` → HTTP POST to Subhosting    |
| LLM                       | Direct `fetch()` (local keys)                          | Through broker (LLM proxy)                        |
| Tunnels                   | Not required (everything local)                        | WebSocket to remote machines                      |
| Auth                      | Not required                                           | OIDC + credentials materialization                |

**Three isolation levels locally — Process / Worker / Subprocess:**

- **Process** (main) = the Broker. Owns cron, routes messages, handles lifecycle.
- **Worker** = one agent. Same constraints as Subhosting:
  no `Deno.cron()`, no shared memory, message-based communication.
- **Subprocess** (`Deno.Command`) = isolated code execution. Local equivalent of
  Sandbox in deploy mode. Ephemeral process with controlled permissions.

The agent code stays identical across both modes. Only transport changes
(`postMessage` vs HTTP, `Deno.Command` vs Sandbox API).

Locally, the main process owns cron (`Deno.cron()`) and dispatches to workers.
On Deploy, the Broker does the same over HTTP to Subhosting agents.

## Heartbeat

Heartbeat is just another cron job, but execution depends on the mode.

**Local mode** — the main process owns the cron and dispatches to the worker:

```typescript
// Main process (local broker)
const cron = new CronManager();
await cron.heartbeat(async () => {
  // Send to the agent worker
  agentWorker.postMessage({ type: "cron_trigger", job: "heartbeat" });
}, 5);
```

**Deploy mode** — one static `Deno.cron()` dispatches for all agents:

```typescript
// Broker side (Deno Deploy) — one cron, dynamic dispatch
Deno.cron("agent-cron-dispatcher", "* * * * *", async () => {
  const kv = await Deno.openKv();
  for await (const entry of kv.list<CronSchedule>({ prefix: ["cron_schedules"] })) {
    if (isDue(entry.value)) {
      await fetch(`https://${entry.value.agentUrl}/cron/${entry.value.job}`, {
        method: "POST",
      });
    }
  }
});

// Agent side (Subhosting) — receives HTTP, no local cron
async handleCron(req: Request): Promise<Response> {
  // Check whether there is pending scheduled work
  return Response.json({ status: "ok" });
}
```

The agent **declares** its cron jobs in config. The Broker **persists them in
KV**, and the dispatcher **evaluates them every minute**. `Deno.cron()` is
statically extracted by Deploy, so it cannot be built dynamically in a loop.
That is why the single-dispatcher pattern exists.

## Modules to create

| Module                         | Role                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `src/orchestration/broker.ts`  | Main Broker — Deploy, LLM proxy, message router, cron dispatcher              |
| `src/orchestration/gateway.ts` | HTTP + WebSocket gateway — channels, sessions                                 |
| `src/orchestration/auth.ts`    | Auth — `@deno/oidc` (agents + tunnels), credentials materialization (sandbox) |
| `src/orchestration/client.ts`  | HTTP client for broker communication (OIDC auth)                              |
| `src/orchestration/relay.ts`   | Tunnel mesh — WS client, capabilities, reconnect                              |
| `src/orchestration/sandbox.ts` | Sandbox code executor — API v2                                                |
| `src/agent/runtime.ts`         | Agent runtime — reactive HTTP handler, KV state, Broker calls through fetch   |
| `src/agent/cron.ts`            | CronManager — `Deno.cron()` (Broker/local), config declarations (agents)      |
| `src/llm/manager.ts`           | LLM provider manager — API key + OAuth, fallback, routing                     |
| `src/messaging/a2a/`           | A2A protocol — types, server, client, cards, tasks                            |
| `src/messaging/bus.ts`         | MessageBus — KV Queues (Broker/local only)                                    |

## Implementation order

1. **Minimal Broker** — LLM proxy (API key + OAuth) + HTTP router on Deploy
2. **Agent runtime** — reactive HTTP handler + HTTP `BrokerClient` (OIDC) + KV state
3. **Local workers** — local multi-agent mode (Process / Worker / Subprocess)
4. **Sandbox executor** — hardened code execution
5. **Tunnel mesh** — nodes, broker federation, local machines
6. **Cron dispatcher** — KV-backed scheduler + HTTP dispatch
7. **Inter-agent A2A** — HTTP routing + SSE streaming (long tasks)
8. **Agent lifecycle** — Subhosting API v2 (Apps/Revisions)
9. **Dashboard** — state observation through KV Watch (Broker KV)


## Canonical task naming glossary

- **canonical task message**: the domain-level A2A message that represents user intent or continuation input, independent from transport wrappers
- **taskMessage**: preferred payload field for `task_submit` broker/runtime envelopes
- **continuationMessage**: preferred payload field for `task_continue` broker/runtime envelopes
- **initialMessage**: preferred field used to create the first canonical task history entry
- **statusMessage**: preferred field attached to a task state transition
- **message**: temporary compatibility alias kept during migration; not the long-term preferred field name

