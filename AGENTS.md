# CLAUDE.md — DenoClaw

## Package & Conventions

|                 |                                                                         |
| --------------- | ----------------------------------------------------------------------- |
| Package         | `@denoclaw/denoclaw`                                                    |
| Language        | TypeScript (Deno 2.7.5)                                                 |
| File references | Repo-root relative (`src/agent/loop.ts:42`)                             |
| Import style    | `.ts` extensions, import map in `deno.json`, no inline `npm:` or `jsr:` |

## Project Overview

DenoClaw is a Deno-native AI agent framework inspired by nano-claw/PicoClaw.
Zero Node.js dependencies. Agents run as dedicated Deno Deploy apps (warm-cached
isolates, stateful via KV), execute code in Deno Sandbox (ephemeral, hardened
permissions), and communicate via a Broker on Deno Deploy (LLM proxy, message
router, tunnel hub, cron scheduler). The Broker orchestrates; agents stay
reactive over HTTP request/response. Inter-agent communication uses A2A
protocol. See `docs/architecture-distributed.md` and ADRs in `docs/`.

## AX — Agent Experience Principles

All interfaces designed for agents, not humans.

> _"Reliability comes not from better prompts, but from better execution
> interfaces."_

| #  | Principle                    | Rule                                                                                                     |
| -- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1  | **No Verb Overlap**          | Unique commands + explicit enums. No two operations share a name or ambiguous alias.                     |
| 2  | **Safe Defaults**            | `dry_run: true` on all write ops. Opt-in explicit for mutations.                                         |
| 3  | **Structured Outputs**       | Machine-readable returns (`taskId`, `status`, `progress`). No console spinners, no prose-only responses. |
| 4  | **Machine-Readable Errors**  | Structured codes (`code` + `context` + `recovery`). Agents parse codes, not sentences.                   |
| 5  | **Fast Fail Early**          | Validate inputs at the boundary, reject before costly operations. Never let bad data travel deep.        |
| 6  | **Deterministic Outputs**    | Same inputs = same outputs. Zero hidden dependency on time or randomness.                                |
| 7  | **Explicit Over Implicit**   | No magic defaults that silently change behavior. Every flag, every mode, every side-effect is visible.   |
| 8  | **Composable Primitives**    | Each function does one thing. Pipeline steps are independent and recombinable.                           |
| 9  | **Narrow Contracts**         | Take the minimum input, return the minimum useful output. No God objects.                                |
| 10 | **Co-located Documentation** | Docs live next to code. Tests are executable documentation.                                              |
| 11 | **Test-First Invariants**    | Every behavior has a test. Prioritize edge cases over happy path.                                        |

**Operational loop:** Plan → Scope → Act → Verify → Recover.

Every tool, error, broker interface, and agent API must be AX-compliant. Review
code through this lens.

## Import Boundaries (DDD)

```
src/shared/          ← nothing (shared kernel — leaf of the dependency graph)
src/telemetry/       ← shared/ (cross-cutting, importable by all domains)
src/llm/             ← shared/, telemetry/
src/agent/           ← shared/, llm/, telemetry/ (NEVER config/, NEVER orchestration/)
src/messaging/       ← shared/, agent/ (a2a/card only), telemetry/
src/config/          ← shared/, agent/, llm/, messaging/ (Config aggregate)
src/orchestration/   ← shared/, agent/, llm/, messaging/, config/, telemetry/
src/cli/             ← shared/, config/, messaging/, orchestration/ (dynamic import in main.ts agent path)
main.ts              ← everything (entrypoint)
```

Hard rules:

- `src/agent/` must NEVER import from `src/orchestration/` (uses
  `AgentBrokerPort` interface from shared/ instead)
- `src/agent/` must NEVER import from `src/config/` (uses structural
  `AgentLoopConfig` instead)
- `src/llm/` must NEVER import from `src/config/` (takes `ProvidersConfig` not
  `Config`)
- `src/shared/` imports from NOTHING

## Build, Test & Development Commands

| Command               | Purpose                                       |
| --------------------- | --------------------------------------------- |
| `deno task dev`       | Dev with watch (gateway + agents + dashboard) |
| `deno task start`     | Run in dev mode (alias for dev)               |
| `deno task deploy`    | Deploy broker to Deno Deploy                  |
| `deno task publish`   | Push agents to remote broker                  |
| `deno task test`      | Run all tests                                 |
| `deno task check`     | Type-check `main.ts` + `mod.ts`               |
| `deno task lint`      | Lint                                          |
| `deno task fmt`       | Format                                        |
| `deno task dashboard` | Vite dashboard dev                            |

All commands require `--unstable-kv --unstable-cron`. Already configured in
`deno.json` tasks.

**Deprecated** (still work with a warning): `gateway` → use `dev`, `broker` →
use `deploy`, `setup` → use `init`, `sync-agents` → use `publish`.

## CLI Commands

```
denoclaw init                 Guided setup (provider + channel + agent)
denoclaw dev                  Work locally (gateway + agents + dashboard)
denoclaw dev --agent <id>     REPL with a specific agent
denoclaw deploy               Deploy/update the broker on Deno Deploy
denoclaw publish [agent]      Push agent(s) to the remote broker
denoclaw status               Show local + remote status
denoclaw logs                 Stream broker logs
denoclaw agent list           List all agents
denoclaw agent create <name>  Create an agent
denoclaw agent delete <name>  Delete an agent
denoclaw tunnel [url]         Connect a local tunnel to the broker
```

## CLI Flags / Config

| Flag / Var                     | Purpose                                         |
| ------------------------------ | ----------------------------------------------- |
| `-m, --message`                | Send a single message (with `dev --agent`)      |
| `-s, --session`                | Session ID (default: "default")                 |
| `-a, --agent`                  | Target agent                                    |
| `--model`                      | Override LLM model                              |
| `--org`                        | Deno Deploy organization                        |
| `--app`                        | Deno Deploy app name                            |
| `--json`                       | Structured JSON output (AX mode)                |
| `--yes, -y`                    | Skip all confirmations                          |
| `--prod`                       | Deploy to production (default: true)            |
| `ANTHROPIC_API_KEY`            | Anthropic API key                               |
| `OPENAI_API_KEY`               | OpenAI API key                                  |
| `OLLAMA_API_KEY`               | Ollama Cloud API key                            |
| `DENOCLAW_API_TOKEN`           | Gateway/broker auth token                       |
| `LOG_LEVEL`                    | Logger level: debug, info, warn, error          |
| `OTEL_DENO`                    | Enable OpenTelemetry (`1` to activate)          |
| `GITHUB_CLIENT_ID`             | GitHub OAuth app client ID (dashboard auth)     |
| `GITHUB_CLIENT_SECRET`         | GitHub OAuth app client secret (dashboard auth) |
| `DENOCLAW_DASHBOARD_AUTH_MODE` | Dashboard auth mode: `github`, `token`, `none`  |

## Git & CI/CD

- Small fixes: commit + push to main.
- Features: branch → PR → merge.
- Version managed in: `deno.json`.
- Do not bump version unless explicitly asked.
- Commit style: conventional commits (`feat:`, `fix:`, `docs:`, `simplify:`).
- Never commit: `.env`, credentials, API keys.

## Architecture

### High-Level Structure

```
┌─── Deno Deploy ──────────────────┐
│                                   │
│  Broker (server.ts)               │
│  ├── LLM Proxy (API + CLI)        │
│  ├── Message Router (KV Queues)   │
│  ├── Tunnel Hub (WebSocket)       │
│  ├── Metrics (/stats)             │
│  └── Agent Lifecycle              │
│                                   │
│  Agent apps (per-agent KV)        │
│  ├── agent "researcher"           │
│  ├── agent "coder"                │
│  └── agent "reviewer"             │
│                                   │
└──────┬──────────┬────────────────┘
       │ tunnel   │ tunnel
┌──────┴───┐ ┌───┴──────┐
│ Local     │ │ Instance │
│ (tools)   │ │ B broker │
└──────────┘ └──────────┘
```

### Key Patterns

- **Broker → Agent App → Sandbox**: Broker orchestrates (cron, routing,
  lifecycle). Agent apps are reactive (warm-cached V8 isolates, wake on HTTP,
  sleep when idle). Code execution happens in Sandbox (ephemeral, hardened). No
  `Deno.cron()` or `listenQueue()` in agent apps. In local mode: **Process**
  (broker) → **Worker** (agent) → **Subprocess** (`Deno.Command`, sandbox). Same
  3-layer model, same code, different transport.
- **Broker as single entry point**: All LLM calls, tool executions, and
  inter-agent messages go through the broker. Agents and tunnels never exposed
  publicly.
- **A2A protocol**: Inter-agent communication via Google's Agent-to-Agent
  protocol (JSON-RPC 2.0). Peers explicitly declared, closed by default.
- **Tunnel dual mode**: `local` (machine → broker for tools + auth), `instance`
  (broker → broker for cross-instance A2A).
- **Permissions by intersection** (ADR-005): Each tool declares needs, each
  agent declares allowed. Sandbox gets the intersection. Deny by default.

### Data Flow

```
User → Channel (Telegram/Webhook) → Broker → HTTP POST → Agent (Deploy app)
Agent → Broker (llm_request) → LLM API or CLI on VPS → Broker → Agent
Agent → Broker (tool_request) → Sandbox or Tunnel → Broker → Agent
Agent → Broker (task_submit) → peer check → HTTP POST or Tunnel → Target Agent
Agent → Broker (task_continue) → peer check → HTTP POST or Tunnel → Target Agent
Broker → Deno.cron() → HTTP POST /cron/:job → Agent (Deploy app)  [scheduled tasks]
```

## Error Handling

All errors extend `DenoClawError` with structured fields:

| Error           | When                                                     |
| --------------- | -------------------------------------------------------- |
| `ConfigError`   | Config file missing, invalid JSON, bad schema            |
| `ProviderError` | LLM API HTTP error, no provider for model, CLI not found |
| `ToolError`     | Tool execution failure                                   |
| `ChannelError`  | Channel not found, send failure                          |

Every error has `code` (enum string), `context` (data), `recovery` (what to do).
Example:

```typescript
throw new ProviderError(
  "NO_PROVIDER",
  { model },
  "Add an API key or use ollama/claude-cli",
);
```

Do NOT add local try/catch unless the error needs transformation or a specific
recovery path.

## External APIs / Services

### Deno Deploy Agent Apps

- API: **v2** (`https://api.deno.com/v2`) — v1 sunsets July 2026, use v2 for all
  new code
- Auth: Bearer token (organization access token, `ddo_...`)
- Used for: agent lifecycle (CRUD deployments)
- Limitations: no `Deno.cron()`, no `Deno.Kv.listenQueue()`, isolates are
  warm-cached (not persistent)

### Deno Sandbox

- Auth: `DENO_DEPLOY_ORG_TOKEN` (preferred), `DENO_SANDBOX_API_TOKEN` legacy
  alias, or OIDC
- Used for: ephemeral code execution with hardened permissions

### LLM Providers

| Provider     | Base URL                       | Auth                |
| ------------ | ------------------------------ | ------------------- |
| Anthropic    | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| OpenAI       | `https://api.openai.com/v1`    | `OPENAI_API_KEY`    |
| Ollama Cloud | `https://api.ollama.com/v1`    | `OLLAMA_API_KEY`    |
| Claude CLI   | Local `Deno.Command`           | OAuth browser flow  |
| Codex CLI    | Local `Deno.Command`           | OAuth browser flow  |

## Coding Style & Patterns

- Types: `PascalCase`. Functions/vars: `camelCase`. Files: `snake_case.ts` or
  `mod.ts`.
- Structured errors everywhere — `{ code, context, recovery }`, never raw
  strings.
- `dry_run: true` default on all write operations (shell, write_file).
- Enums (`SandboxPermission`, `ChannelRouting`, `BrokerMessageType`) instead of
  free strings.
- Keep files concise. Extract helpers instead of duplicating.
- Comments: only for tricky/non-obvious logic. No docstrings on untouched code.

## Security Guardrails

- All agents run in Sandbox — no code executes directly inside the deployed
  agent app runtime.
- Sandbox permissions by intersection (tool needs ∩ agent allows). Deny by
  default.
- A2A peers explicitly declared. Closed by default (`peers: []`,
  `acceptFrom: []`).
- Gateway protected by `DENOCLAW_API_TOKEN` on all endpoints except `/`.
- CLI auth via OAuth browser flow — tokens stay on the machine, never in config.
- GCP OIDC + Secret Manager available for zero static secrets (ADR-004,
  optional).
- Credentials materialization for Sandbox → Broker auth (ADR-003).

## What NOT to Do

- Do not execute code directly in agent apps — always dispatch to Sandbox.
- Do not expose agent endpoints publicly — only the broker has a public URL.
- Do not use raw string errors — always `DenoClawError` with
  code/context/recovery.
- Do not use inline `npm:` or `jsr:` specifiers — add to `deno.json` imports.
- Do not add features or refactor beyond what was asked.
- Do not commit API keys, tokens, or `.env` files.

## Testing

|            |                                                             |
| ---------- | ----------------------------------------------------------- |
| Run        | `deno task test`                                            |
| Location   | Colocated `*_test.ts` (same directory as source)            |
| Unit tests | Mock `globalThis.fetch` for providers, use temp dirs for FS |
| KV tests   | Use `sanitizeResources: false, sanitizeOps: false`          |

All tests must pass before pushing (`deno task test` + `deno task lint` +
`deno task check`).

### Testing Guardrails

- Prefer narrow tests that validate the touched behavior.
- Mock `fetch` for provider tests. Use `Deno.makeTempDir()` for FS tests.
- Do not modify test helpers to silence failures — fix the root cause.

## Environment Variables

See CLI Flags / Config section. Key variables:

| Variable                       | Purpose                                         | Default                      |
| ------------------------------ | ----------------------------------------------- | ---------------------------- |
| `ANTHROPIC_API_KEY`            | Anthropic LLM API                               | none                         |
| `OPENAI_API_KEY`               | OpenAI LLM API                                  | none                         |
| `OLLAMA_API_KEY`               | Ollama Cloud API                                | none                         |
| `DENOCLAW_API_TOKEN`           | Gateway auth                                    | none (no auth in local mode) |
| `LOG_LEVEL`                    | Logger verbosity                                | `info`                       |
| `OTEL_DENO`                    | Enable OTEL                                     | disabled                     |
| `DENO_SANDBOX_API_TOKEN`       | Sandbox API                                     | none                         |
| `GITHUB_CLIENT_ID`             | GitHub OAuth app client ID                      | none                         |
| `GITHUB_CLIENT_SECRET`         | GitHub OAuth app client secret                  | none                         |
| `DENOCLAW_DASHBOARD_AUTH_MODE` | Dashboard auth mode (`github`, `token`, `none`) | `none`                       |
| `DENO_DEPLOY_ORG_TOKEN`        | Deploy v2 organization token (publish, sandbox) | none                         |
| `DENO_DEPLOY_PAT`              | Personal Deploy token                           | none                         |

## ADRs

| ADR | Decision                                          |
| --- | ------------------------------------------------- |
| 001 | Agent apps on Deploy, code execution in Sandbox   |
| 002 | LLM Proxy dual: API + CLI on VPS, auth via tunnel |
| 003 | OIDC + credentials materialization                |
| 004 | GCP Secret Manager via OIDC (optional)            |
| 005 | Sandbox permissions by intersection               |
| 006 | A2A protocol for inter-agent communication        |
| 007 | Real-time dashboard observability                 |
| 008 | Deploy agent runtime corrections                  |
| 009 | Agent memory (kvdex dual: KV + .md)               |
| 010 | Exec policy and sandbox backend                   |
| 011 | A2A canonical internal protocol                   |
| 012 | Agent workspace structure (definition vs runtime) |

## Collaboration & Safety Notes

- Never commit real credentials, PII, or live config values.
- Do not change version without explicit consent.
- When answering questions, verify in code first — do not guess.
- Keep changes scoped: a bug fix doesn't need surrounding code cleaned up.
- Do not add features, refactor, or make "improvements" beyond what was asked.
