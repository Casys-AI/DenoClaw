# ADR-001: Agent Apps on Deploy, Code Execution in Sandbox

**Status:** Accepted **Date:** 2026-03-26

## Context

DenoClaw must run AI agents that use LLMs, tools (shell, files, CLI), and
communicate with each other. The question is: which hosting and isolation model
should agents use?

## Options Considered

1. **Web Workers** — isolated threads in the same Deno process (rejected for
   deploy, **kept for local mode**)
2. **Everything in Sandbox** — Linux microVMs for everything
3. **Broker + Agent App + Sandbox** — Broker orchestrates, a Deploy app hosts
   the agent, Sandbox handles code execution

## Decision

**Three layers, each with a distinct role:**

- **Broker** (Deno Deploy) — orchestrates everything: cron, message routing,
  agent lifecycle. The only long-running component.
- **Deno Deploy agent apps** — hosts the agent (warm-cached V8 isolate, KV bound
  for state/memory). Wakes over Broker HTTP and goes idle afterward. No
  `Deno.cron()`, no `listenQueue()`.
- **Deno Sandbox** — executes agent code with hardened permissions (skills,
  tools, LLM-generated code)

No code runs directly inside the deployed agent app runtime. The agent runtime
is a reactive endpoint: it receives messages over Broker HTTP, calls the broker
for LLM access, and delegates all code execution to an ephemeral Sandbox.

> **Deno Deploy API:** use **v2** (`api.deno.com/v2`). v1 sunsets in July 2026.

## Architecture

```
┌─── Broker (Deno Deploy) ────────────────────────────────┐
│  Orchestrates: cron, routing, lifecycle                │
│  Long-running, Deno.cron() + KV Queues available       │
│                                                         │
│  HTTP POST → Agent App                                 │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│  Deploy agent app — warm-cached V8 isolate           │
│                                                         │
│  Agent runtime (our code, reactive logic)              │
│  Bound KV (memory, sessions, state — always persists)  │
│  Wakes over HTTP, sleeps when idle                     │
│                                                         │
│  When code must run:                                   │
│  └─→ Sandbox (ephemeral microVM)                       │
│       - Hardened permissions                           │
│       - Network allowlist (broker only)                │
│       - No secrets                                     │
│       - 30 min max                                     │
│       - User skills, LLM-generated code, tools         │
│       └─→ executes code, returns the result            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Role of Each Layer

|           | Broker (Deploy)              | Deploy agent app                      | Sandbox (execution)      |
| --------- | ---------------------------- | ------------------------------------- | ------------------------ |
| Lifetime  | Long-running                 | Warm-cached (sleeps when idle)        | Ephemeral, 30 min max    |
| KV        | Yes (routing, global state)  | Bound (memory, sessions)              | None (ephemeral)         |
| Cron      | Yes (`Deno.cron()`)          | **No**                                | No                       |
| Queues    | Yes (`listenQueue()`)        | **No**                                | No                       |
| Role      | Orchestration, cron, routing | Agent state, reactive logic           | Code execution           |
| Code run  | Broker only                  | Our agent runtime only                | Skills, tools, LLM code  |
| Isolation | Deno Deploy                  | V8 isolate (per deployment)           | Linux microVM (hardened) |
| Secrets   | LLM API keys                 | Credentials materialization (ADR-003) | None, ever               |
| Network   | Public (endpoints)           | Broker only                           | Broker only (allowlist)  |

## Rationale

- **Separation of orchestration / state / execution** — the Broker orchestrates,
  the agent manages state, Sandbox executes code
- **Warm-cached + ephemeral** — the agent wakes on request in its Deploy app,
  while execution is short-lived (Sandbox, 30 min max). The Broker is the only
  long-running component.
- **Bound KV** — each deployed agent has an explicitly bound KV (created via the
  v2 API) for memory and sessions. KV persists independently of the isolate.
- **Hardened permissions** — code runs in the most secure layer (microVM), not
  in the agent
- **Single trust model** — no distinction between "trusted code" and "untrusted
  code"; everything goes through Sandbox
- **Controlled cost** — agent apps are available on the free tier (1M req/month,
  60 deploys/hour). Builder is $200/month for production (20M req, 300
  deploys/hour). Sandbox is billed only during execution

## Consequences

- The deployed agent runtime is lightweight and reactive: HTTP ingress, broker
  calls, Sandbox dispatch
- The agent has no internal loop — the Broker drives each step over HTTP
- Each code execution creates a Sandbox instance → boot latency (~1s) on every
  tool call
- The Broker manages the lifecycle of all three layers: cron/routing (itself),
  Deploy agent apps (agent CRUD via v2 API), Sandbox (execution CRUD)
- Sandboxes persist nothing — every result must flow back through the broker to
  the agent app KV for persistence
- The deployed agent isolate stays warm between closely spaced calls (bursts
  during a task), then shuts down after idle

## Local Mode — Process / Worker / Subprocess

Locally, the same 3-layer model applies with Deno primitives:

| Deploy                        | Local                           | Role                        |
| ----------------------------- | ------------------------------- | --------------------------- |
| Broker (Deno Deploy)          | **Process** (main)              | Orchestrates, cron, routing |
| Deploy agent app (V8 isolate) | **Worker** (`new Worker()`)     | Agent, state in local KV    |
| Sandbox (microVM)             | **Subprocess** (`Deno.Command`) | Isolated code execution     |

Workers are the right local choice: the same constraints as deployed agent apps
(no cron, no shared memory, `postMessage` ≈ HTTP). The Worker → Agent App
transition is nearly transparent. Subprocesses (`Deno.Command`) provide
process-level isolation (Deno permissions, timeout, isolated env), the local
equivalent of Sandbox microVMs.
