# ADR-006: A2A (Agent-to-Agent) for Inter-Agent Communication

**Status:** Accepted **Date:** 2026-03-27

## Context

DenoClaw agents must be able to delegate tasks to one another, both within the
same deployment and with external agents. The question is: which protocol should
be used for that communication?

## Options Considered

1. **Custom BrokerMessage format** — what we currently have
2. **A2A (Agent-to-Agent)** — open Google/Linux Foundation protocol, v1.0
3. **MCP** — Anthropic's Model Context Protocol

## Decision

**Use A2A for inter-agent communication, and more broadly as the canonical task
contract. Use MCP for tools.**

- A2A = horizontal (agent ↔ agent) — peer task delegation, locally and over the
  network
- MCP = vertical (agent → tools) — access to tools and data

Both coexist. A DenoClaw agent uses MCP for internal tools and A2A to describe
agentic work, including when execution flows through an internal transport.

> **A2A over transport X, persisted in KV, correlated by task/context ids.**

## A2A in Brief

**Transport:** JSON-RPC 2.0 over HTTPS + SSE for streaming.

**Key objects:**

| Object    | Role                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| AgentCard | "Business card" published at `/.well-known/agent-card.json` — skills, endpoint, auth |
| Task      | Unit of work, with lifecycle: submitted → working → completed/failed                 |
| Message   | Communication inside a Task: role (user/agent) + Parts                               |
| Part      | Atomic content: TextPart, FilePart, DataPart, FunctionCallPart                       |
| Artifact  | Output produced by a Task, composed of Parts                                         |
| Skill     | Capability declared on the AgentCard                                                 |

**Task lifecycle:**

```
submitted → working → completed
                    → failed
                    → canceled
           input_required ↔ working (multi-turn)
```

**RPC methods:**

- `message/send` — send a message, receive the sync response
- `message/stream` — send and receive over SSE (streaming)
- `tasks/get` — poll status
- `tasks/cancel` — cancel
- `tasks/pushNotificationConfig/set` — webhook for async long-running tasks

## Mapping to DenoClaw

| Current DenoClaw         | A2A                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `AgentEntry` (registry)  | `AgentCard` (skills, capabilities)                                                                                               |
| `BrokerMessage` (custom) | JSON-RPC 2.0 `message/send`                                                                                                      |
| `ChannelMessage`         | A2A `Message` with `Parts`                                                                                                       |
| `Skill` type             | A2A `AgentSkill` (+ id, tags, examples)                                                                                          |
| KV Queue routing         | Broker routes canonically via `task_submit`/`task_continue`. KV Queue is an optional local transport, not the routing mechanism. |
| WebSocket streaming      | SSE via `Deno.serve()` + `ReadableStream`                                                                                        |

## Architecture

```
Agent "researcher" (Deploy app)     Broker (Deploy)         Agent "coder" (Deploy app)
     │                                   │                       │
     │ /.well-known/agent-card.json      │                       │ /.well-known/agent-card.json
     │ skills: [research, analyze]       │                       │ skills: [code, test, review]
     │                                   │                       │
     │  A2A message/send                 │                       │
     │  Task: "write code for finding"   │                       │
     ├──────── HTTP POST (OIDC) ────────►│                       │
     │                                   │  routes to "coder"    │
     │                                   ├──── HTTP POST ───────►│
     │                                   │                       │ executes
     │                                   │                       │ (working → completed)
     │                                   │◄──── HTTP response ───┤
     │◄──────── HTTP response ──────────┤  Task result           │
```

Each deployed agent exposes an HTTP A2A endpoint. The broker:

1. Routes Tasks between internal agents (HTTP POST to each deployed agent)
2. Routes cross-instance Tasks (via Broker ↔ Broker tunnels)
3. Receives/sends Tasks from external agents (standard A2A HTTP)

## DenoClaw Agent Card

Each agent in the registry automatically generates its Agent Card:

```json
{
  "name": "coder",
  "description": "Writes and executes code",
  "version": "1.0.0",
  "protocolVersion": "1.0",
  "url": "https://denoclaw-coder.deno.dev/a2a",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "authentication": { "schemes": ["Bearer"] },
  "skills": [
    {
      "id": "shell_exec",
      "name": "Shell Execution",
      "description": "Execute shell commands in sandbox",
      "tags": ["coding", "shell"]
    },
    {
      "id": "file_write",
      "name": "File Operations",
      "description": "Read and write files",
      "tags": ["coding", "files"]
    }
  ]
}
```

## Implementation (native Deno, zero deps)

No A2A SDK is required — the protocol is JSON-RPC 2.0 over HTTP and can be
implemented with `Deno.serve()` and `fetch()`:

**A2A server (expose an agent):**

```typescript
Deno.serve((req) => {
  const url = new URL(req.url);

  // Discovery
  if (url.pathname === "/.well-known/agent-card.json") {
    return Response.json(agentCard);
  }

  // JSON-RPC endpoint
  if (url.pathname === "/a2a" && req.method === "POST") {
    const rpc = await req.json();
    switch (rpc.method) {
      case "message/send":
        return handleSend(rpc);
      case "message/stream":
        return handleStream(rpc);
      case "tasks/get":
        return handleGetTask(rpc);
      case "tasks/cancel":
        return handleCancel(rpc);
    }
  }
});
```

**A2A client (call an agent):**

```typescript
const card = await fetch("https://agent.dev/.well-known/agent-card.json").then(
  (r) => r.json(),
);

const result = await fetch(card.url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Write a test for this function" }],
      },
    },
  }),
}).then((r) => r.json());
```

## Implemented Modules

| Module                        | Role                                                                                               | Status   |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| `src/messaging/a2a/types.ts`  | Full A2A v1.0 types (AgentCard, Task, Message, Part, Skill, JSON-RPC, SSE)                         | **done** |
| `src/messaging/a2a/server.ts` | A2A server: JSON-RPC (message/send, message/stream, tasks/get, tasks/cancel) + SSE streaming       | **done** |
| `src/messaging/a2a/client.ts` | A2A client: discover, send, stream (SSE async generator), getTask, cancelTask                      | **done** |
| `src/messaging/a2a/card.ts`   | AgentCard generation from registry config (permissions → skills)                                   | **done** |
| `src/messaging/a2a/tasks.ts`  | KV task store (lifecycle SUBMITTED→WORKING→COMPLETED/FAILED, artifacts, terminal-state protection) | **done** |
| `src/orchestration/broker.ts` | Peer verification (PEER_NOT_ALLOWED, PEER_REJECTED) in inter-agent routing                         | **done** |

## Consequences

- Every DenoClaw agent is interoperable with any A2A agent (LangChain, Bedrock,
  etc.)
- Internal transports may keep runtime messages, but they no longer form a
  parallel task contract: the canonical work semantics remain A2A
- The AgentCard is generated automatically from agent config (registry)
- SSE streaming is native in Deno, with no library required
- Compatible with channel → agent(s) routing: the broker is an A2A router
