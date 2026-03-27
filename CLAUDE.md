# CLAUDE.md — DenoClaw

## Package & Conventions

| | |
|---|---|
| Package | `@denoclaw/denoclaw` |
| Language | TypeScript (Deno 2.7.5) |
| File references | Repo-root relative (`src/agent/loop.ts:42`) |
| Import style | `.ts` extensions, import map in `deno.json`, no inline `npm:` or `jsr:` |

## Project Overview

DenoClaw is a Deno-native AI agent framework inspired by nano-claw/PicoClaw. Zero Node.js dependencies. Agents live in Deno Subhosting (warm-cached isolates, stateful via KV), execute code in Deno Sandbox (ephemeral, hardened permissions), and communicate via a Broker on Deno Deploy (LLM proxy, message router, tunnel hub, cron scheduler). The Broker orchestrates — agents are reactive (HTTP request/response). Inter-agent communication uses A2A protocol. See `docs/architecture-distributed.md` and ADRs in `docs/`.

## AX — Agent Experience Principles

All interfaces designed for agents, not humans.

> *"Reliability comes not from better prompts, but from better execution interfaces."*

| # | Principle | Rule |
|---|---|---|
| 1 | **No Verb Overlap** | Unique commands + explicit enums. No two operations share a name or ambiguous alias. |
| 2 | **Safe Defaults** | `dry_run: true` on all write ops. Opt-in explicit for mutations. |
| 3 | **Structured Outputs** | Machine-readable returns (`taskId`, `status`, `progress`). No console spinners, no prose-only responses. |
| 4 | **Machine-Readable Errors** | Structured codes (`code` + `context` + `recovery`). Agents parse codes, not sentences. |
| 5 | **Fast Fail Early** | Validate inputs at the boundary, reject before costly operations. Never let bad data travel deep. |
| 6 | **Deterministic Outputs** | Same inputs = same outputs. Zero hidden dependency on time or randomness. |
| 7 | **Explicit Over Implicit** | No magic defaults that silently change behavior. Every flag, every mode, every side-effect is visible. |
| 8 | **Composable Primitives** | Each function does one thing. Pipeline steps are independent and recombinable. |
| 9 | **Narrow Contracts** | Take the minimum input, return the minimum useful output. No God objects. |
| 10 | **Co-located Documentation** | Docs live next to code. Tests are executable documentation. |
| 11 | **Test-First Invariants** | Every behavior has a test. Prioritize edge cases over happy path. |

**Operational loop:** Plan → Scope → Act → Verify → Recover.

Every tool, error, broker interface, and agent API must be AX-compliant. Review code through this lens.

## Import Boundaries

```
src/types.ts       ← everything (shared types, no logic)
src/utils/         ← everything (log, errors, helpers)
src/config/        ← utils
src/agent/tools/   ← types, utils
src/agent/         ← tools, providers, config, utils
src/providers/     ← types, utils, telemetry
src/bus/           ← types, utils, telemetry
src/channels/      ← types, utils, bus
src/session/       ← types, utils
src/cron/          ← types, utils
src/gateway/       ← agent, channels, bus, session, utils
src/broker/        ← providers, sandbox, telemetry, utils
src/relay/         ← agent/tools, broker/types, utils
src/telemetry/     ← utils (+ optional @opentelemetry/api)
src/sandbox/       ← utils
src/cli/           ← config, utils
main.ts            ← everything (entrypoint)
```

`src/broker/` must NEVER import from `src/gateway/`. `src/agent/` must NEVER import from `src/broker/`.

## Build, Test & Development Commands

| Command | Purpose |
|---|---|
| `deno task dev` | Dev with watch |
| `deno task start` | Run agent CLI |
| `deno task gateway` | Run gateway server |
| `deno task test` | Run all tests |
| `deno task check` | Type-check `main.ts` + `mod.ts` |
| `deno task lint` | Lint |
| `deno task fmt` | Format |

All commands require `--unstable-kv --unstable-cron`. Already configured in `deno.json` tasks.

## CLI Flags / Config

| Flag / Var | Purpose |
|---|---|
| `-m, --message` | Send a single message |
| `-s, --session` | Session ID (default: "default") |
| `--model` | Override LLM model |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OLLAMA_API_KEY` | Ollama Cloud API key |
| `DENOCLAW_API_TOKEN` | Gateway auth token |
| `LOG_LEVEL` | Logger level: debug, info, warn, error |
| `OTEL_DENO` | Enable OpenTelemetry (`1` to activate) |

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
                    │  Subhosting agents (per-agent KV) │
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

- **Broker → Subhosting → Sandbox**: Broker orchestrates (cron, routing, lifecycle). Agents in Subhosting are reactive (warm-cached V8 isolates, wake on HTTP, sleep when idle). Code execution in Sandbox (ephemeral, hardened). No `Deno.cron()` or `listenQueue()` in Subhosting. In local mode: **Process** (broker) → **Worker** (agent) → **Subprocess** (`Deno.Command`, sandbox). Same 3-layer model, same code, different transport.
- **Broker as single entry point**: All LLM calls, tool executions, and inter-agent messages go through the broker. Agents and tunnels never exposed publicly.
- **A2A protocol**: Inter-agent communication via Google's Agent-to-Agent protocol (JSON-RPC 2.0). Peers explicitly declared, closed by default.
- **Tunnel dual mode**: `local` (machine → broker for tools + auth), `instance` (broker → broker for cross-instance A2A).
- **Permissions by intersection** (ADR-005): Each tool declares needs, each agent declares allowed. Sandbox gets the intersection. Deny by default.

### Data Flow

```
User → Channel (Telegram/Webhook) → Broker → HTTP POST → Agent (Subhosting)
Agent → Broker (llm_request) → LLM API or CLI on VPS → Broker → Agent
Agent → Broker (tool_request) → Sandbox or Tunnel → Broker → Agent
Agent → Broker (agent_message) → peer check → HTTP POST or Tunnel → Target Agent
Broker → Deno.cron() → HTTP POST /cron/:job → Agent (Subhosting)  [scheduled tasks]
```

## Error Handling

All errors extend `DenoClawError` with structured fields:

| Error | When |
|---|---|
| `ConfigError` | Config file missing, invalid JSON, bad schema |
| `ProviderError` | LLM API HTTP error, no provider for model, CLI not found |
| `ToolError` | Tool execution failure |
| `ChannelError` | Channel not found, send failure |

Every error has `code` (enum string), `context` (data), `recovery` (what to do). Example:
```typescript
throw new ProviderError("NO_PROVIDER", { model }, "Add an API key or use ollama/claude-cli");
```

Do NOT add local try/catch unless the error needs transformation or a specific recovery path.

## External APIs / Services

### Deno Deploy / Subhosting

- API: **v2** (`https://api.deno.com/v2`) — v1 sunsets July 2026, use v2 for all new code
- Auth: Bearer token (Subhosting access token)
- Used for: agent lifecycle (CRUD deployments)
- Limitations: no `Deno.cron()`, no `Deno.Kv.listenQueue()`, isolates are warm-cached (not persistent)

### Deno Sandbox

- Auth: `DENO_SANDBOX_API_TOKEN` or OIDC
- Used for: ephemeral code execution with hardened permissions

### LLM Providers

| Provider | Base URL | Auth |
|---|---|---|
| Anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| Ollama Cloud | `https://api.ollama.com/v1` | `OLLAMA_API_KEY` |
| Claude CLI | Local `Deno.Command` | OAuth browser flow |
| Codex CLI | Local `Deno.Command` | OAuth browser flow |

## Coding Style & Patterns

- Types: `PascalCase`. Functions/vars: `camelCase`. Files: `snake_case.ts` or `mod.ts`.
- Structured errors everywhere — `{ code, context, recovery }`, never raw strings.
- `dry_run: true` default on all write operations (shell, write_file).
- Enums (`SandboxPermission`, `ChannelRouting`, `BrokerMessageType`) instead of free strings.
- Keep files concise. Extract helpers instead of duplicating.
- Comments: only for tricky/non-obvious logic. No docstrings on untouched code.

## Security Guardrails

- All agents run in Sandbox — no code executes in Subhosting directly.
- Sandbox permissions by intersection (tool needs ∩ agent allows). Deny by default.
- A2A peers explicitly declared. Closed by default (`peers: []`, `acceptFrom: []`).
- Gateway protected by `DENOCLAW_API_TOKEN` on all endpoints except `/`.
- CLI auth via OAuth browser flow — tokens stay on the machine, never in config.
- GCP OIDC + Secret Manager available for zero static secrets (ADR-004, optional).
- Credentials materialization for Sandbox → Broker auth (ADR-003).

## What NOT to Do

- Do not execute code directly in Subhosting agents — always dispatch to Sandbox.
- Do not expose agent endpoints publicly — only the broker has a public URL.
- Do not use raw string errors — always `DenoClawError` with code/context/recovery.
- Do not use inline `npm:` or `jsr:` specifiers — add to `deno.json` imports.
- Do not add features or refactor beyond what was asked.
- Do not commit API keys, tokens, or `.env` files.

## Testing

| | |
|---|---|
| Run | `deno task test` |
| Location | Colocated `*_test.ts` (same directory as source) |
| Unit tests | Mock `globalThis.fetch` for providers, use temp dirs for FS |
| KV tests | Use `sanitizeResources: false, sanitizeOps: false` |

All tests must pass before pushing (`deno task test` + `deno task lint` + `deno task check`).

### Testing Guardrails

- Prefer narrow tests that validate the touched behavior.
- Mock `fetch` for provider tests. Use `Deno.makeTempDir()` for FS tests.
- Do not modify test helpers to silence failures — fix the root cause.

## Environment Variables

See CLI Flags / Config section. Key variables:

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic LLM API | none |
| `OPENAI_API_KEY` | OpenAI LLM API | none |
| `OLLAMA_API_KEY` | Ollama Cloud API | none |
| `DENOCLAW_API_TOKEN` | Gateway auth | none (no auth in local mode) |
| `LOG_LEVEL` | Logger verbosity | `info` |
| `OTEL_DENO` | Enable OTEL | disabled |
| `DENO_SANDBOX_API_TOKEN` | Sandbox API | none |

## ADRs

| ADR | Decision |
|---|---|
| 001 | Agents in Subhosting, code execution in Sandbox |
| 002 | LLM Proxy dual: API + CLI on VPS, auth via tunnel |
| 003 | OIDC + credentials materialization |
| 004 | GCP Secret Manager via OIDC (optional) |
| 005 | Sandbox permissions by intersection |
| 006 | A2A protocol for inter-agent communication |

## Collaboration & Safety Notes

- Never commit real credentials, PII, or live config values.
- Do not change version without explicit consent.
- When answering questions, verify in code first — do not guess.
- Keep changes scoped: a bug fix doesn't need surrounding code cleaned up.
- Do not add features, refactor, or make "improvements" beyond what was asked.
