# DenoClaw Distributed Architecture

## Core Principle

**The Broker orchestrates. The agent reacts. Code runs in Sandbox.**

**A2A over WebSocket, persisted in KV (kvdex), correlated by task/context ids.**

The architecture has three layers, each with a distinct role (ADR-001):

- **Broker** (Deno Deploy) = central orchestrator (LLM proxy, cron, message
  routing, agent lifecycle). The only truly long-running component.
- **Agent app** (Deno Deploy) = the reactive agent runtime (persistent WebSocket
  connection to the Broker, KV-backed state and memory via kvdex). Maintains a
  WebSocket link (`denoclaw.agent.v1` subprotocol) to the Broker and receives
  work through it. **No `Deno.cron()`, no `listenQueue()`.**
- **Sandbox** = execution (ephemeral, hardened permissions, user
  skills/tools/LLM-generated code)

No user/tool/LLM-generated code runs directly inside the deployed agent app
runtime. Everything goes through Sandbox with locked-down permissions.

> **Deno Deploy API:** use **v2** (`api.deno.com/v2`). v1 is deprecated and
> sunsets in July 2026.

## Overview

```
┌─────────────── DENO DEPLOY (Broker) ──────────────┐
│                                                     │
│  ┌───────────────────────────────────────────┐     │
│  │           LLM Gateway / Proxy              │     │
│  │  API key mode: keys live on the broker     │     │
│  │  OAuth mode: OAuth token (browser flow)    │     │
│  │  Rate limiting, cost tracking, fallback    │     │
│  └──────────────────┬────────────────────────┘     │
│                      │                              │
│  ┌──────────────────┴────────────────────────┐     │
│  │        Agent WebSocket Hub                 │     │
│  │  denoclaw.agent.v1 = agent connections     │     │
│  │  denoclaw.tunnel.v1 = tunnel connections   │     │
│  │  KV Queues = broker-internal durability    │     │
│  │  KV Watch = real-time observation          │     │
│  └──────────────────┬────────────────────────┘     │
│                      │                              │
└──────────────────────┼──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          │ WS agent.v1│ WS agent.v1│
          ▼            ▼            ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │Agent App A │ │Agent App B │ │Agent App C │
   │(Deploy app)│ │(Deploy app)│ │(Deploy app)│
   │ Private KV │ │ Private KV │ │ Private KV │
   │  ↓ exec    │ │  ↓ exec    │ │  ↓ exec    │
   │ Sandbox    │ │ Sandbox    │ │ Sandbox    │
   │(Firecracker│ │(Firecracker│ │(Firecracker│
   │  microVM)  │ │  microVM)  │ │  microVM)  │
   └────────────┘ └────────────┘ └────────────┘

          Tunnels (denoclaw.tunnel.v1)
          ┌─────────────┐     ┌──────────┐
          │ Machine A    │     │ VPS/GPU  │
          │ Shell, FS    │     │ Tools    │
          │ Auth flow    │     │          │
          └──────┬───────┘     └────┬─────┘
                 │ WS tunnel.v1     │ WS tunnel.v1
                 └──────────────────┘
                         │
                    ┌────┴────┐
                    │ Broker  │
                    └─────────┘
```

**Key distinction:** agents are **separate Deno Deploy apps**, not subhosts
inside the Broker. Each agent initiates a WebSocket connection TO the Broker
(the agent is the WS client, the Broker is the WS server).

## Components

### 1. Broker (Deno Deploy)

The Broker is the control plane. It is decomposed into specialized sub-runtimes:

| Sub-runtime                  | File                                       | Role                                                 |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `BrokerServer`               | `broker/server.ts`                         | Top-level composition, HTTP handler, KV ownership    |
| `BrokerLlmProxy`            | `broker/llm_proxy.ts`                      | LLM provider routing (API key + OAuth), fallback     |
| `BrokerTaskDispatcher`       | `broker/task_dispatch.ts`                  | Route A2A tasks to target agents                     |
| `BrokerToolDispatcher`       | `broker/tool_dispatch.ts`                  | Route tool calls to tunnels or sandbox               |
| `BrokerReplyDispatcher`      | `broker/reply_dispatch.ts`                 | Route agent replies back to requesters               |
| `BrokerMessageRuntime`       | `broker/message_runtime.ts`                | Process incoming WebSocket messages from agents       |
| `BrokerHttpRuntime`          | `broker/http_runtime.ts`                   | HTTP route handling                                  |
| `BrokerLifecycleRuntime`     | `broker/lifecycle_runtime.ts`              | Agent creation, destruction, monitoring              |
| `BrokerFederationRuntime`    | `broker/federation_runtime.ts`             | Cross-instance broker-to-broker routing              |
| `BrokerAgentSocketRegistry`  | `broker/agent_socket_registry.ts`          | Track connected agent WebSocket sessions             |
| `BrokerAgentRegistry`        | `broker/agent_registry.ts`                 | Agent metadata and KV-backed registry                |
| `BrokerAgentMessageRouter`   | `broker/agent_message_router.ts`           | Message routing logic (WS → agent, tunnel, federated)|
| `BrokerTaskPersistence`      | `broker/persistence.ts`                    | KV-backed task state persistence                     |
| `BrokerCronManager`          | `broker/cron_manager.ts`                   | KV-backed schedules + `Deno.cron()` lifecycle        |
| `TunnelRegistry`             | `broker/tunnel_registry.ts`                | Active tunnel tracking + capability lookup           |
| `BrokerSandboxManager`       | `broker/sandbox_manager.ts`                | Sandbox provisioning and lifecycle                   |

The Broker is responsible for:

- **LLM Proxy** — two auth modes, one final `fetch()` call (ADR-002):
  - **API key mode:** the broker holds provider keys (Anthropic, OpenAI, etc.)
  - **OAuth mode:** token acquired through a browser flow, same mechanism as
    Claude CLI / Codex CLI, stored on the Broker
  - The agent never knows which mode is in use. The interface stays uniform:
    `broker.complete()`
- **Agent WebSocket Hub** — accepts `denoclaw.agent.v1` connections from agent
  apps. Routes A2A tasks, LLM responses, and tool results over the persistent
  WebSocket. The Broker also enforces A2A permissions.
- **Tunnel Hub** — accepts `denoclaw.tunnel.v1` connections from local machines,
  VPS/GPU nodes, and other Brokers. Each tunnel declares its **capabilities**
  (tools, auth). The broker routes based on those declarations.
- **Cron Dispatcher** — broker-owned `Deno.cron()` handlers persisted in KV and
  dispatched as canonical broker tasks to target agents.
- **Agent Lifecycle** — creates, destroys, and monitors agents via the Deno
  Deploy **v2** API (Apps/Revisions) and Sandbox executions.
- **Auth** — `@deno/oidc` for agent apps and tunnels. Credentials
  materialization for Sandboxes (ADR-003). The target is zero static secrets.

### 2. Agents (Deno Deploy agent apps + Sandbox)

Each agent is one separate Deploy app deployment. It maintains a persistent
WebSocket connection to the Broker using `WebSocketBrokerTransport`
(`denoclaw.agent.v1` subprotocol). Actual code execution happens inside
ephemeral Sandboxes.

**Agent app runtime (persistent WebSocket client):**

- Connects to Broker via WebSocket on startup (`deploy_runtime.ts`)
- Fetches its config from the Broker over HTTP (`/agents/:id/config`)
- Receives work (tasks, continuations) through the WebSocket connection
- Has bound KV for memory and sessions (via kvdex), which persists independently
  of the isolate
- Requests LLM completions from the Broker through the same WebSocket
- Dispatches code execution to Sandboxes
- Persists results in KV
- **Never** executes arbitrary user/tool/LLM code directly
- **No `Deno.cron()`** — scheduled work is managed by the Broker

**Sandbox (executor):**

- Ephemeral (30-minute max), created on demand
- **Deploy mode:** Firecracker microVM via `@deno/sandbox` (jsr)
- **Local mode:** `Deno.Command` subprocess with restricted `--allow-*` flags
- ExecPolicy enforcement (ADR-010) BEFORE spawn
- No secrets visible to the executed code (credentials materialization, ADR-003)
- Executes user skills, tools, and LLM-generated code via `tool_executor.ts`
- Returns the result and exits

```typescript
// Agent app — WebSocket-driven runtime (deploy_runtime.ts)

// 1. Fetch config from broker over HTTP
const agentEntry = await fetchCanonicalBrokerAgentConfig({
  brokerUrl,
  authToken,
  agentId,
});

// 2. Connect to broker via WebSocket (denoclaw.agent.v1)
const brokerTransport = new WebSocketBrokerTransport(agentId, {
  brokerUrl,
  endpoint: agentEndpoint,
  authToken,
  onBrokerMessage: (msg) => runtime.handleIncomingMessage(msg),
});
await brokerTransport.start();

// 3. AgentRuntime processes work received through the WebSocket
class AgentRuntime {
  // Port interfaces — never touches concrete Broker directly
  private llmPort: AgentLlmToolPort;
  private taskPort: AgentCanonicalTaskPort<Task>;

  async handleIncomingMessage(envelope: BrokerEnvelope): Promise<void> {
    if (envelope.type === "task_submit") {
      await this.executeAgentConversation(envelope);
    }
    // ... other message types
  }

  private async executeAgentConversation(envelope: BrokerEnvelope) {
    // LLM call through the broker (via WebSocket)
    const llmResponse = await this.llmPort.complete({
      messages: await this.buildContext(envelope),
      model: "anthropic/claude-sonnet-4-6",
    });

    // Tool call → execute in Sandbox
    if (llmResponse.toolCalls) {
      for (const tc of llmResponse.toolCalls) {
        const result = await this.llmPort.executeTool({
          tool: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        });
      }
    }
  }
}
```

### 3. Two WebSocket protocols

DenoClaw uses two distinct WebSocket subprotocols, both negotiated with strict
handshakes:

| Protocol              | Constant                     | Purpose                              | Client             | Server |
| --------------------- | ---------------------------- | ------------------------------------ | ------------------- | ------ |
| `denoclaw.agent.v1`   | `DENOCLAW_AGENT_PROTOCOL`   | Agent app ↔ Broker communication     | Agent app (Deploy)  | Broker |
| `denoclaw.tunnel.v1`  | `DENOCLAW_TUNNEL_PROTOCOL`  | Tunnel ↔ Broker (machines, federation)| Local/VPS/Broker B | Broker |

Both require:

- `Authorization: Bearer <token>` header
- Mandatory subprotocol in `Sec-WebSocket-Protocol`
- Fail-fast rejection if subprotocol is missing or wrong
- Explicit `idleTimeout` on the broker side

### 4. Tunnels (denoclaw.tunnel.v1)

The tunnel connects everything outside Deno Deploy: local machines, VPS/GPU
nodes, and other Brokers (federation).

#### Three connection types

| Type                | Connects                 | Usage                                                   |
| ------------------- | ------------------------ | ------------------------------------------------------- |
| **Node → Broker**   | Machine/VPS/GPU → Broker | Remote tools (shell, FS, GPU), browser-based OAuth auth |
| **Broker → Broker** | Instance A ↔ Instance B  | Cross-instance A2A federation                           |
| **Local → Broker**  | Dev machine → Broker     | Local tools, auth flow, tests                           |

Agents never connect to tunnels directly. They always go through the Broker
via their `denoclaw.agent.v1` WebSocket.

```
Instance A                    Instance B                    Local machine
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Broker A │◄═══ tunnel ════►│ Broker B │                 │ denoclaw │
│  ↑ WS    │                 │  ↑ WS    │                 │ LocalRelay│
│ agents   │                 │ agents   │                 └────┬─────┘
└──────────┘                 └──────────┘                      │
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
```

#### Capabilities

Each tunnel declares what it exposes:

```typescript
{
  tunnelId: "machine-erwan",
  tools: ["shell", "fs_read", "fs_write"],
  allowedAgents: ["agent-123", "agent-456"],
}
```

The broker maintains a `TunnelRegistry` of active tunnels and routes
tool requests to tunnels that advertise matching capabilities.

## Full message flow

```
1. User sends a message (Telegram, API, webhook)
           │
2. Broker receives it, creates/loads a session, creates a canonical A2A task
           │
3. Broker sends the task to the agent over its WebSocket (denoclaw.agent.v1)
           │  WS: { id, from: "broker", to: "agent-a", type: "task_submit", payload: {...} }
           │
4. Agent (already connected via persistent WS) receives and processes the task
           │
5. Agent requests an LLM completion from the broker (same WS, request/response)
           │  WS: { type: "llm_request", payload: { model: "...", messages: [...] } }
           │
6. Broker resolves the provider:
           │  ├─ model = "anthropic/..." → fetch() with API key (held by the broker)
           │  ├─ model = "openai/..."    → fetch() with API key
           │  └─ model = "claude-oauth"  → fetch() with OAuth token (from browser flow)
           │
7. Broker returns the LLM response over the WS
           │
8. If there is a tool call, the agent asks the broker to execute it (same WS)
           │  WS: { type: "tool_request", payload: { tool: "shell", args: {...} } }
           │
9. Broker routes to the right tunnel based on declared capabilities
           │  Tunnel WS (denoclaw.tunnel.v1): { tool: "shell", args: {...} }
           │
10. Local machine executes and sends the result back over its tunnel WS
           │
11. Broker returns the result to the agent over the agent's WS
           │
12. Agent continues its loop (back to step 5) or responds
           │
13. Final response travels back through the Broker → user
```

**Cron / Heartbeat (Deploy mode):**

```
BrokerCronManager (Deno.cron) → broker-owned task_submit → Agent receives over WS
```

## Inter-agent communication

Agents never talk to each other directly because of network isolation.
Everything goes through the Broker over WebSocket.

In other words: **A2A over WebSocket, persisted in KV (kvdex), correlated by
task/context ids.**

```typescript
// Agent A wants to delegate a task to Agent B
// It sends a peer message to the Broker over its WS connection
await brokerClient.submitTask({
  to: "agent-b",
  payload: { instruction: "Analyze this file", data: "..." },
});
// → Broker receives over agent-a's WS, routes to agent-b over agent-b's WS

// Agent B receives it on its WS, processes it, replies through the Broker
await brokerClient.sendTextTask({
  to: "agent-a",
  text: "Analysis complete",
  payload: { analysis: "..." },
});
```

The broker checks **permissions**: is Agent A allowed to talk to Agent B?
(`allowedPeers` in agent configuration)

## KV Architecture

DenoClaw uses `@olli/kvdex` (jsr) layered on top of `Deno.Kv` for structured
collections with secondary indices.

### Two KV databases per agent (local mode)

| KV database     | Path                                  | Owner          | Contents                                            |
| --------------- | ------------------------------------- | -------------- | --------------------------------------------------- |
| **Shared KV**   | `./data/shared.db`                    | Main process   | A2A tasks, agent status, traces, metrics, bus queues|
| **Private KV**  | `./data/agents/<agentId>/memory.db`   | Agent Worker   | Conversation history, long-term facts (kvdex)       |

### Deploy mode

On Deploy, `Deno.openKv()` with no path uses the platform-managed KV
(FoundationDB-backed). Each Deploy app has its own bound KV.

### KV key namespaces (shared KV)

- `["a2a_tasks", taskId]` — A2A task records (`TaskStore`)
- `["agents", agentId, "status"]` — agent liveness (`AgentStatusValue`)
- `["trace", ...]` — telemetry traces
- `["metrics", ...]` — metrics (`MetricsCollector`)

### Agent private KV (kvdex collections)

- `convMessages` — indexed by `sessionId`, stores conversation turns
- `longTermFacts` — indexed by `topic`, stores long-term agent facts

## State observation (KV Watch)

The broker exposes agent state through KV. Any authorized component can watch
it:

```typescript
for await (
  const entries of kv.watch([
    ["agents", "agent-a", "status"],
    ["agents", "agent-b", "status"],
  ])
) {
  // Real time: { task: "analyzing", progress: 0.7 }
}
```

## Security (see ADR-003, ADR-010)

Principle: **zero static secrets.** Everywhere.

| Boundary                                 | Mechanism                                                    | Static secret?                   |
| ---------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| Sandbox isolation (deploy)               | Firecracker microVM (`@deno/sandbox`)                        | N/A                              |
| Sandbox isolation (local)                | `Deno.Command` subprocess, restricted `--allow-*` flags     | N/A                              |
| Sandbox ExecPolicy (ADR-010)             | `ExecPolicyGuard` — allowlist/denylist enforced BEFORE spawn | N/A                              |
| Agent (Deploy app) → Broker              | `@deno/oidc` (preferred), fallback invite token              | No                               |
| Sandbox → Broker                         | Credentials materialization (token invisible to code)        | No                               |
| Broker → Deploy agent apps               | `@deno/oidc` (ephemeral token)                               | No                               |
| Tunnel → Broker                          | Ephemeral OIDC / one-time invite token                       | No                               |
| Broker → LLM API                         | API key or OAuth token (one-shot browser flow)               | No (GCP Secret Manager, ADR-004) |
| Inter-agents                             | Broker validates every message (`allowedPeers`)              | N/A                              |
| Transport (agent)                        | TLS (`wss://`), subprotocol `denoclaw.agent.v1`              | N/A                              |
| Transport (tunnel)                       | TLS (`wss://`), subprotocol `denoclaw.tunnel.v1`             | N/A                              |

### ExecPolicy (ADR-010)

Before any sandbox execution, the `ExecPolicyGuard` evaluates the command
against the agent's configured policy:

```typescript
type ExecPolicy =
  | { security: "deny" }                    // block all execution
  | { security: "full"; envFilter?: string[] }  // allow everything
  | {
      security: "allowlist";
      allowedCommands?: string[];            // whitelist
      deniedCommands?: string[];             // blacklist
      envFilter?: string[];
      allowInlineEval?: boolean;
    };
```

## Advantages of the centralized LLM proxy

Sending **all** LLM calls through the broker gives:

- **Cost tracking** per agent / per user
- **Centralized rate limiting**
- **Fallback chains** (Anthropic down → switch to OpenAI)
- **Caching** for identical responses
- **Central logs** for all LLM calls
- **Provider switching** without changing agents

## LLM OAuth auth through a tunnel

When the Broker uses OAuth mode, it needs a browser for the initial
authentication flow. The tunnel routes that URL to a local machine:

1. Broker initiates an OAuth/device-code flow with the LLM provider
2. It emits
   `{ type: "auth_request", url: "https://auth.anthropic.com/...", code: "ABCD-1234" }`
3. The tunnel routes the request to a local machine explicitly allowed for that
   flow
4. The local machine opens the browser with the URL
5. The user authenticates
6. The OAuth token travels back: tunnel → Broker
7. The Broker stores the token (KV or Secret Manager)

**This is a one-shot flow.** After the initial auth, the Broker uses the OAuth
token directly in its `fetch()` calls to the LLM API.

## Local mode vs Deploy

DenoClaw runs in both modes. The code is the same; only the transport and
sandbox backend change.

|                            | Local mode                                            | Deploy mode                                          |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Broker / Main              | Main **Deno process**                                 | Deno Deploy app                                      |
| Agent runtime              | **Worker** (one per agent, `worker_entrypoint.ts`)    | Deploy agent app (`deploy_runtime.ts`)               |
| Code execution             | **Subprocess** (`Deno.Command`, `LocalProcessBackend`)| Firecracker microVM (`DenoSandboxBackend`)           |
| Broker ↔ Agent transport   | `postMessage` / `onmessage` (Worker protocol)         | WebSocket (`denoclaw.agent.v1`, `WebSocketBrokerTransport`) |
| Agent → Sandbox transport  | `Deno.Command` (spawn + stdin/stdout)                 | `@deno/sandbox` API (HTTP to microVM)                |
| KV (shared)                | SQLite (`./data/shared.db`)                           | Deno Deploy managed KV (FoundationDB)                |
| KV (private)               | SQLite (`./data/agents/<id>/memory.db`)               | Deploy app bound KV                                  |
| KV ORM                     | `@olli/kvdex` (both modes)                            | `@olli/kvdex` (both modes)                           |
| Cron / Heartbeat           | Embedded broker `Deno.cron()` → local Worker          | Broker `Deno.cron()` → canonical `task_submit` over WS|
| LLM                        | Direct `fetch()` (local keys)                         | Through broker (LLM proxy)                           |
| Tunnels                    | Not required (everything local)                       | WebSocket to remote machines (`denoclaw.tunnel.v1`)  |
| Auth                       | Not required                                          | OIDC + credentials materialization                   |
| Shutdown coordination      | `BroadcastChannel("denoclaw")`                        | Deploy app lifecycle                                 |

### Three isolation levels locally — Process / Worker / Subprocess

- **Process** (main) = the Broker. Owns cron, routes messages, manages
  `WorkerPool`, holds shared KV.
- **Worker** = one agent. Same constraints as deployed agent apps: no
  `Deno.cron()`, no shared memory. Communication via typed `postMessage`
  (`WorkerRequest`/`WorkerResponse` protocol).
- **Subprocess** (`Deno.Command`) = isolated code execution. Local equivalent of
  Firecracker Sandbox in deploy mode. Ephemeral process with controlled
  `--allow-*` permissions and ExecPolicy enforcement.

### WorkerPool architecture (local mode)

The `WorkerPool` is decomposed into specialized sub-modules:

| Module                       | File                              | Role                                    |
| ---------------------------- | --------------------------------- | --------------------------------------- |
| `WorkerPool`                 | `worker_pool.ts`                  | Top-level composition, spawn Workers    |
| `WorkerPoolLifecycle`        | `worker_pool_lifecycle.ts`        | Worker init, shutdown, restart          |
| `WorkerPoolPeerRouter`       | `worker_pool_peer_router.ts`      | Inter-agent message routing (local)     |
| `WorkerPoolObservability`    | `worker_pool_observability.ts`    | Status tracking, KV writes for agents   |
| `WorkerPoolRequestTracker`   | `worker_pool_request_tracker.ts`  | Pending request correlation             |

### Worker protocol classification

Worker messages are classified as:

- **Infra messages** (lifecycle): `init`, `shutdown`, `ready`, `task_started`,
  `task_completed`
- **Execution messages** (plumbing): `run`, `peer_deliver`, `peer_response`,
  `cron_response` → `run_result`, `run_error`, `peer_send`, `peer_result`,
  `task_observe`, `cron_request`

The agent code stays identical across both modes. Only the transport and sandbox
backend change (`postMessage` vs `WebSocketBrokerTransport`, `Deno.Command` vs
`@deno/sandbox`).

## Heartbeat

Heartbeat is currently broker-derived, not a dedicated cron task.

- The broker writes agent liveness from active WebSocket state and recent broker
  activity.
- Agent runtimes do not register their own heartbeat jobs and do not write
  heartbeat status directly.
- A dedicated broker-managed heartbeat cron can still be added later if passive
  liveness signals prove insufficient.

## BrokerClient and BrokerTransport

`BrokerClient` (`src/orchestration/client.ts`) is the agent-side abstraction
for communicating with the Broker. It implements both `AgentLlmToolPort` and
`AgentCanonicalTaskPort<Task>` interfaces via dependency injection — the
`AgentRuntime` never touches the concrete Broker directly.

`BrokerClient` delegates to a pluggable `BrokerTransport` interface:

```typescript
interface BrokerTransport {
  start(): Promise<void>;
  send(message, timeoutMs?): Promise<BrokerResponseMessage>;
  close(): void;
}
```

The only concrete implementation is `WebSocketBrokerTransport`
(`transport_websocket.ts`), which:

- Connects to `<brokerUrl>/agent-socket` with `denoclaw.agent.v1` subprotocol
- Auto-reconnects on disconnect
- Correlates request/response via `BrokerTransportRequestTracker`
- Handles both request/response (LLM, tools) and push (tasks) on the same socket

Locally, Workers don't use `BrokerClient` at all — they communicate with the
main process via `postMessage` using the `WorkerRequest`/`WorkerResponse`
typed protocol.

## Modules

| Module                                          | Role                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `src/orchestration/broker/server.ts`            | Main Broker — 15+ sub-runtimes (see Components § Broker)              |
| `src/orchestration/broker/cron_manager.ts`      | BrokerCronManager — KV-backed schedules + `Deno.cron()` lifecycle     |
| `src/orchestration/gateway.ts`                  | HTTP + WebSocket gateway — channels, sessions                         |
| `src/orchestration/auth.ts`                     | Auth — `@deno/oidc`, credentials materialization                      |
| `src/orchestration/client.ts`                   | BrokerClient — agent-side broker abstraction (LLM + task ports)       |
| `src/orchestration/transport_websocket.ts`      | WebSocketBrokerTransport — `denoclaw.agent.v1` WS transport           |
| `src/orchestration/relay.ts`                    | LocalRelay — `denoclaw.tunnel.v1` WS client for local machines        |
| `src/orchestration/tunnel_protocol.ts`          | Tunnel protocol constants and handshake validation                    |
| `src/orchestration/agent_socket_protocol.ts`    | Agent socket protocol constants and handshake validation              |
| `src/agent/tools/backends/local.ts`             | LocalProcessBackend — `Deno.Command` sandbox for local mode           |
| `src/agent/tools/backends/cloud.ts`             | DenoSandboxBackend — Firecracker microVM via `@deno/sandbox`          |
| `src/agent/tools/backends/exec_policy_guard.ts` | ExecPolicyGuard — pre-spawn command policy enforcement (ADR-010)      |
| `src/agent/tools/tool_executor.ts`              | Standalone script run inside sandbox (both backends)                  |
| `src/agent/runtime.ts`                          | AgentRuntime — task-oriented runtime with port interfaces             |
| `src/agent/deploy_runtime.ts`                   | Deploy bootstrap — config fetch, WS connect, runtime start            |
| `src/agent/worker_pool.ts`                      | WorkerPool — local multi-agent (spawn/manage Workers)                 |
| `src/agent/worker_entrypoint.ts`                | Worker bootstrap script (loaded by `new Worker(...)`)                 |
| `src/agent/loop.ts`                             | AgentLoop — synchronous request-response loop for local Workers       |
| `src/agent/memory_kvdex.ts`                     | KvdexMemory — kvdex-backed conversation + long-term facts             |
| `src/llm/manager.ts`                            | LLM provider manager — Anthropic, OpenAI, Ollama, CLI                 |
| `src/messaging/a2a/`                            | A2A protocol — types, server, client, cards, tasks                    |
| `src/messaging/bus.ts`                          | MessageBus — KV Queues (channel messages, Broker/local only)          |

## Implementation order

1. **Minimal Broker** — LLM proxy (API key + OAuth) + WebSocket hub on Deploy
2. **Agent runtime** — WebSocket-driven handler + `BrokerClient` + KV state
3. **Local workers** — local multi-agent mode (Process / Worker / Subprocess)
4. **Sandbox executor** — hardened code execution (local + cloud backends)
5. **Tunnel mesh** — nodes, broker federation, local machines
6. **Cron dispatcher** — KV-backed scheduler + canonical task dispatch
7. **Inter-agent A2A** — WebSocket routing + task persistence
8. **Agent lifecycle** — Deno Deploy API v2 (Apps/Revisions)
9. **Dashboard** — state observation through KV Watch (Broker KV)

## Canonical task naming glossary

- **canonical task message**: the domain-level A2A message that represents user
  intent or continuation input, independent from transport wrappers
- **taskMessage**: preferred payload field for `task_submit` broker/runtime
  envelopes
- **continuationMessage**: preferred payload field for `task_continue`
  broker/runtime envelopes
- **initialMessage**: preferred field used to create the first canonical task
  history entry
- **statusMessage**: preferred field attached to a task state transition
- **message**: temporary compatibility alias kept during migration; not the
  long-term preferred field name
