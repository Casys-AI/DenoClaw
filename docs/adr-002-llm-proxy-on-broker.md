# ADR-002: Centralized LLM Proxy on the Broker — API Key + OAuth

**Status:** Accepted **Date:** 2026-03-26

## Context

Agents run in Subhosting (ADR-001). They call the Broker over HTTP for
everything: LLM, tools, A2A. Sandboxes (code execution) have access to no
secret. LLMs require authentication, whether via API keys (Anthropic, OpenAI)
or OAuth tokens (browser flow, like Claude CLI / Codex CLI).

Agents never talk to each other directly (no public URL). Everything flows
through the Broker. The tunnel is DenoClaw's network mesh: it connects brokers,
nodes, and machines, similar to Tailscale.

## Decision

**The Broker (Deno Deploy) is the central router for EVERYTHING leaving an
agent**: LLM calls, tool execution, and inter-agent communication. The
WebSocket tunnel is a first-class primitive.

### Two LLM Authentication Modes

Both modes ultimately use `fetch()` to call the LLM API. Only the authentication
method changes.

**API Key Mode** — for providers with static keys (Anthropic, OpenAI, DeepSeek,
etc.)

- The broker holds the API keys (Deploy env vars or GCP Secret Manager,
  ADR-004)
- The agent requests a completion, and the broker performs the `fetch()` with
  the key

**OAuth Mode** — browser authentication (same flow as Claude CLI / Codex CLI)

- The broker initiates an OAuth/device code flow
- The tunnel routes the auth URL to the local machine → the user signs in in
  their browser (one-shot)
- The broker stores the OAuth token (KV or Secret Manager)
- Subsequent LLM calls use `fetch()` with the OAuth token, just like API key
  mode

Both modes are transparent to the agent through the uniform
`broker.complete()` interface.

## Flow — LLM Call (identical for both auth modes)

```
Agent (Subhosting)               Broker (Deploy)              LLM API
     │                                │                          │
     │  POST /llm { messages, model } │                          │
     ├──── HTTP (OIDC auth) ─────────►│                          │
     │                                │  + injects API key       │
     │                                │    or OAuth token        │
     │                                ├─── fetch() ─────────────►│
     │                                │◄── response ─────────────┤
     │◄── HTTP response ──────────────┤                          │
     │  { content, toolCalls }        │                          │
```

The agent does not know which auth mode is used — the `broker.complete()`
interface stays uniform.

## Initial OAuth Auth (one-shot)

When the Broker has no API key and uses OAuth mode (the same flow as Claude CLI
/ Codex CLI):

```
Broker (Deploy)                           Local machine (tunnel)
     │                                          │
     │  Anthropic auth needed                   │
     │  → generates device code / OAuth URL     │
     │                                          │
     ├──── tunnel: auth_request {url, code} ───►│
     │                                    opens browser
     │                                    user signs in
     │◄──── tunnel: OAuth token ────────────────┤
     │                                          │
     │  Stores token (KV / Secret Manager)      │
     │  fetch() now uses OAuth token            │
```

This is **one-shot** — the Broker stores the token and reuses it directly for
later `fetch()` calls. No `Deno.Command`, no executed CLI, just the same auth
flow used by CLIs.

## Flow — Inter-Agent Communication (A2A)

```
Agent A (Subhosting)             Broker (Deploy)              Agent B (Subhosting)
     │                                │                          │
     │  POST /agent { to:"b", ... }   │                          │
     ├──── HTTP (OIDC) ─────────────►│                          │
     │                                │  verifies permissions    │
     │                                ├──── HTTP POST ──────────►│
     │                                │                          │ handles request
     │                                │◄──── HTTP response ──────┤
     │◄── HTTP response ──────────────┤  { from:"agent-b", ... } │
```

## The Tunnel Is a Primitive, Not an Add-On

The WebSocket tunnel is DenoClaw's **network mesh** — it connects everything
that is not on the same Deploy instance. Like Tailscale, it creates a private
network between machines.

**Three tunnel connection types:**

| Type                | Connects                 | Usage                                                   |
| ------------------- | ------------------------ | ------------------------------------------------------- |
| **Node → Broker**   | Machine/VPS/GPU → Broker | Remote tools (shell, FS, GPU), browser OAuth auth       |
| **Broker → Broker** | Instance A ↔ Instance B  | Cross-instance A2A federation, inter-agent routing      |
| **Local → Broker**  | Dev machine → Broker     | Local tools, auth flow, tests                           |

**Agents** are never directly on the tunnel — they go through their Broker over
HTTP. The tunnel connects **infrastructure components** to each other.

```
Instance A                    Instance B                    Local machine
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Broker A │◄═══ tunnel ════►│ Broker B │                 │ denoclaw │
│  agents  │                 │  agents  │                 │ tunnel   │
└──────────┘                 └──────────┘                 └────┬─────┘
                                                               │
                              VPS (node)                       │
                             ┌──────────┐                      │
                             │GPU       │◄══ tunnel ═══════════╝
                             │Shell/FS  │
                             └──────────┘
```

Each tunnel declares its capabilities:

```typescript
// VPS node with tools
{
  type: "local",
  tools: ["shell", "fs_read", "fs_write"],
  allowedAgents: ["planner", "operator"],
}

// Broker B (inter-instance)
{
  type: "instance",
  agents: ["support", "billing"], // agents routable through this tunnel
}

// Local dev machine
{
  type: "local",
  tools: ["shell", "fs_read", "fs_write"],
  allowedAgents: ["planner", "operator"],
}
```

## Rationale

- **Zero secrets inside agents and Sandboxes** — API keys and OAuth tokens stay
  on the Broker
- **Uniform interface for the agent** — `broker.complete({ messages, model })`
  regardless of auth mode (API key or OAuth)
- **Centralized cost tracking** per agent / per user
- **Centralized rate limiting**
- **Fallback chains** — provider A down → fallback to provider B
- **Centralized cache and logs**
- **Inter-agent routing** — the same broker that routes LLM requests also routes
  messages between agents

## Consequences

- The broker is a single point of failure → mitigation: multi-region Deploy
- The broker must maintain a registry of active tunnels and their capabilities
- The broker stores OAuth tokens in KV (or Secret Manager), enabling automatic
  rotation
- Agents have a single interface: `broker.complete()` for LLM,
  `broker.toolExec()` for tools, `broker.submitTask()` /
  `broker.sendTextTask()` for inter-agent communication
