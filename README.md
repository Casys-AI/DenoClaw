<p align="center">
  <img src="web/static/logo.png" alt="DenoClaw" width="128" />
</p>

# DenoClaw

DenoClaw is a Deno-native runtime for brokered multi-agent workflows. It runs
the control plane on Deno Deploy, agent runtimes as dedicated Deno Deploy apps,
and arbitrary code execution in Deno Sandbox.

The architecture is intentionally split into three layers:

```
Deploy : Broker App (Deno Deploy) → Agent Apps (Deno Deploy) → Sandbox
Local  : Process                   → Workers                  → Subprocess (`Deno.Command`)
```

That split is the core of the system, not an implementation detail:

- **Broker** is the control plane. It owns routing, auth, LLM proxying, cron,
  tunnel coordination, and durable task state.
- **Agent apps** run the agent runtime. Agents are reactive HTTP services with
  per-agent KV-backed state, not long-running daemons.
- **Sandbox** executes arbitrary code and tool calls under an isolated runtime
  boundary with explicit permissions.

The local runtime mirrors the same model with a main process, one Worker per
agent, and one subprocess per tool execution. The goal is the same semantics in
dev and deploy, with transport and isolation swapped to the local equivalents.

## Why this architecture

### Deno Deploy for the Broker

The Broker needs to stay awake, own public ingress, schedule cron jobs, hold
durable coordination state, and mediate all agent-to-agent traffic. Deno Deploy
fits that control-plane role well: HTTP-native, KV-native, and always-on.

### Deploy agent apps for agent runtimes

Agents are a good match for dedicated Deno Deploy apps because they are
request-driven, can benefit from warm isolate reuse, and need bound state, but
they should not own schedulers or durable message transport. DenoClaw treats
agent apps as reactive endpoints, not daemon processes.

### Sandbox for code execution

Tool execution and arbitrary code are isolated from both the Broker and the
agent runtime. This keeps the control plane clean, keeps agent logic portable,
and makes the security boundary explicit. Sandbox permissions are derived from
tool requirements intersected with agent policy.

## Why Deno is a strong fit

DenoClaw uses the same runtime family across local and deploy paths:

| Need                | Deno primitive                        |
| ------------------- | ------------------------------------- |
| HTTP server         | `Deno.serve()`                        |
| Durable state       | `Deno.openKv()`                       |
| Scheduled work      | `Deno.cron()` (Broker/local only)     |
| Local agent runtime | `new Worker()`                        |
| Local code exec     | `Deno.Command`                        |
| Cloud code exec     | Deno Sandbox                          |
| Network I/O         | `fetch()` + `Deno.upgradeWebSocket()` |
| Observability       | built-in OpenTelemetry support        |
| Tests               | `Deno.test()`                         |

That matters because DenoClaw does not need a Node.js compatibility layer,
separate deploy runtime, or a second language/runtime for orchestration. The
same TypeScript codebase spans CLI, local workers, broker deploy, agent deploy
apps, and Sandbox-oriented execution paths.

## Core architectural advantages

- **One mental model across local and deploy.** Broker / Agent / Execution maps
  cleanly to Process / Worker / Subprocess in local mode.
- **Clear isolation boundaries.** Control plane, agent runtime, and code
  execution are separate concerns.
- **Centralized security and observability.** LLM calls, tool requests, A2A
  routing, traces, and auth flow through the Broker.
- **Reactive agents instead of hidden daemons.** The system does not depend on
  unsupported deployed-agent-runtime patterns such as `Deno.cron()` or
  `kv.listenQueue()` inside agent apps.
- **Deno-native end to end.** No Node.js dependency chain and no split runtime
  model.

## Quickstart

```bash
# Install Deno 2.7+
curl -fsSL https://deno.land/install.sh | sh

# Configure an LLM provider
deno task start setup provider

# Configure a channel
deno task start setup channel

# Run an interactive agent session
deno task start agent

# Send a one-off message
deno task start agent -- -m "Hello DenoClaw"

# Start the local gateway
deno task start gateway

# Deploy or update the broker on Deno Deploy
deno task deploy
```

## Deploy setup

The broker deployment is source-controlled and pinned to `main.ts broker` in
`deno.json` so Deno Deploy does not auto-detect the dashboard/Fresh preset or
boot the local runtime path instead of the broker.

For the operator workflow and current deploy status, see
`docs/setup-broker-and-agent-deploy.md`.

Important: the broker deploy path is ready, and agent publication is no longer
just a raw API v2 upload. Published agents now register their endpoint with the
broker, wake up over `POST /tasks`, and connect back over the dedicated agent
WebSocket. The remaining gap is live validation on real Deno Deploy credentials,
not the local KV transport.

## Development

```bash
deno task dev       # Backend with watch
deno task dashboard # Dashboard dev server
deno task test      # Test suite
deno task check     # Type-check
deno task lint      # Lint
deno task fmt       # Format
```

## Repository layout

```
src/
├── agent/          # Agent loop, runtime, memory, skills, tools
├── llm/            # LLM providers and routing
├── messaging/      # Channels, sessions, A2A protocol
├── orchestration/  # Broker, gateway, auth, relay, transports
├── cli/            # CLI entrypoints and setup flows
├── config/         # Config loading and validation
├── shared/         # Shared errors, helpers, logging, types
└── telemetry/      # Metrics and tracing
docs/
├── architecture-distributed.md
├── adr-001-*.md → adr-014-*.md
└── plans/
```

See `docs/architecture-distributed.md`, the ADRs in `docs/`, and `CLAUDE.md` for
the project conventions and architectural decisions.

## License

MIT
