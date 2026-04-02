# Broker and Agent Deploy Setup

## Quick Start — What You Need

To get DenoClaw running, you need exactly **two things**:

1. **A Deno Deploy organization access token** (`DENO_DEPLOY_ORG_TOKEN`) —
   creates apps, deploys revisions, provisions KV databases
2. **At least one LLM provider API key** (e.g. `ANTHROPIC_API_KEY`) — the
   default model is `anthropic/claude-sonnet-4-6`

Everything else is either auto-generated or optional.

### Minimal `.env` file

```bash
# Required
DENO_DEPLOY_ORG_TOKEN=ddo_xxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx

# Auto-generated if missing (but recommended to set explicitly)
DENOCLAW_API_TOKEN=your-broker-auth-token
```

### First deploy in 3 commands

```bash
# 1. Deploy the broker
deno task deploy

# 2. Publish your agents
deno task publish

# 3. Verify
curl https://<broker-url>/health
```

---

## Prerequisites

- Deno 2.7+
- Access to the target Deno Deploy org
- A local Deno Deploy CLI login (`deno deploy` commands work)
- At least one LLM provider API key

## Environment Variables Reference

### Required

| Env var                | When                  | Purpose                                                 |
| ---------------------- | --------------------- | ------------------------------------------------------- |
| `DENO_DEPLOY_ORG_TOKEN`| Deploy + Publish     | Deno Deploy org token (apps, revisions, KV, sandbox)    |
| One LLM provider key   | Always                | LLM calls fail without it                               |

### Strongly recommended

| Env var                | When                  | Purpose                                                 |
| ---------------------- | --------------------- | ------------------------------------------------------- |
| `DENOCLAW_API_TOKEN`   | Deploy + Publish     | Broker auth token. Auto-generated UUID if missing.      |

### Optional

| Env var                             | Purpose                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `DENOCLAW_BROKER_URL`               | Broker URL. Auto-saved by `deno task deploy`.                  |
| `DENOCLAW_BROKER_OIDC_AUDIENCE`     | OIDC audience override. Defaults to broker URL.                |
| `GITHUB_CLIENT_ID`                  | Dashboard OAuth (auto-required on Deploy)                      |
| `GITHUB_CLIENT_SECRET`              | Dashboard OAuth (auto-required on Deploy)                      |
| `GITHUB_ALLOWED_USERS`              | Comma-separated GitHub usernames for dashboard access          |
| `LOG_LEVEL`                         | `debug`, `info`, `warn`, `error`                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`      | Enable OpenTelemetry tracing                                   |

### LLM Provider Keys

Set in `.env` or in `~/.denoclaw/config.json` under `providers`:

| Env var              | Provider    | Model prefix(es)                               |
| -------------------- | ----------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY`  | Anthropic   | `anthropic/`, `claude-`                        |
| `OPENAI_API_KEY`     | OpenAI      | `openai/`, `gpt-`, `o1-`, `o3-`               |
| `OPENROUTER_API_KEY` | OpenRouter  | `openrouter/`                                  |
| `DEEPSEEK_API_KEY`   | DeepSeek    | `deepseek/`, `deepseek-`                       |
| `GROQ_API_KEY`       | Groq        | `groq/`                                        |
| `GEMINI_API_KEY`     | Google      | `gemini/`, `gemini-`                           |
| `OLLAMA_API_KEY`     | Ollama      | `ollama/`, `llama`, `mistral`, `phi`, `qwen2`  |

Ollama runs locally and doesn't require an API key. `claude-cli` and
`codex-cli` providers shell out to their respective CLIs and don't need keys
either.

---

## 1. Broker Setup

### Deploy the broker

From the repository root:

```bash
deno task check
deno task deploy
```

What `deno task deploy` does:

- Ensures the Deno Deploy app exists (canonical name: `denoclaw-broker`)
- Creates or normalizes the app with an explicit dynamic runtime
- Provisions and assigns the shared broker KV database
- Syncs `DENOCLAW_API_TOKEN` and all provider env vars to the broker app
- Uploads the current repo root
- Saves the deployed broker URL and KV database name into local config

### Why `deno.json` must stay broker-oriented

This repository contains a dashboard under `web/` and a Vite/Fresh config. If
Deno Deploy is left to auto-detect the app shape, it can pick the dashboard
preset instead of the broker runtime.

`deno.json` must not point at an agent app:

```json
{
  "deploy": {
    "org": "casys",
    "app": "denoclaw-broker"
  }
}
```

The broker runtime itself is configured during deploy:

- dynamic runtime
- entrypoint `./main.ts`
- args `["broker"]`
- working directory `.`

### Verify the broker

```bash
# Health check (public)
curl <broker-url>/health

# Authenticated endpoint
curl -H "Authorization: Bearer <DENOCLAW_API_TOKEN>" <broker-url>/stats

# Env vars
deno deploy env list --org <org> --app <app>

# Logs
deno deploy logs --org <org> --app <app>
```

---

## 2. Agent Deploy Setup

### Required credentials

```bash
export DENO_DEPLOY_ORG_TOKEN=<org-access-token>  # Required
export DENOCLAW_BROKER_URL=<broker-url>            # Required (or saved by deploy)
```

Notes:

- `DENO_DEPLOY_ORG_TOKEN` is the canonical org-scoped Bearer token used by the
  Deno Deploy v2 API. `DENO_DEPLOY_PAT` (personal token) is **not** used for
  agent publish.
- `DENOCLAW_BROKER_URL` is required so the published agent knows where to open
  its WebSocket connection (`/agent/socket`, `denoclaw.agent.v1` subprotocol).

### Publish one agent

```bash
deno task publish alice
```

### Publish all agents

```bash
deno task publish
```

### The publish flow

1. Loads agents from `data/agents/*`
2. Resolves local `agent.json` + defaults into the publish-time agent config
3. Creates or reuses one Deploy app per agent
4. Snapshots `soul.md`, `skills/`, and `memories/` into the agent workspace
5. Uploads a generated `main.ts` entrypoint plus source assets
6. Creates a new revision through `POST /v2/apps/{app}/deploy`
7. Registers `agentId → endpoint/config` back with the broker

### Workspace sync

By default, publish syncs in **preserve** mode:

- Missing `soul.md` is created remotely when present locally
- If no local `soul.md` exists, publish materializes one from the resolved
  system prompt when available
- Missing `skills/*.md` and `memories/*.md` files are created remotely
- Existing remote files with different content are kept as-is
- Remote-only files are not deleted

Use `--force` to overwrite tracked files:

```bash
deno task publish alice --force
```

### Canonical resource naming

| Resource          | Name pattern                              |
| ----------------- | ----------------------------------------- |
| Broker app        | `denoclaw-broker`                         |
| Agent app         | `denoclaw-agent-<agent-id>`               |
| Broker KV         | `denoclaw-broker-kv`                      |
| Agent KV          | `denoclaw-agent-<agent-id>-kv`            |
| Sandbox instance  | `denoclaw-agent-<agent-id>-sandbox`       |

Some live resources still use legacy names (`denoclaw`, `alice`, `alice-kv`).

---

## 3. How deployed agents connect

Once published, a deployed agent follows this lifecycle:

1. **Cold wake-up** — the broker sends `POST /tasks` to the agent's public URL
   with a `Bearer <DENOCLAW_API_TOKEN>` header
2. **Agent boot** — `startDeployedAgentRuntime()` fetches its config from the
   broker (`GET /agents/:id/config`)
3. **WebSocket connect** — the agent opens a persistent WebSocket to the broker
   at `/agent/socket` with `denoclaw.agent.v1` subprotocol
4. **Auth resolution** (in order):
   1. `DENOCLAW_BROKER_TOKEN` (static)
   2. `DENOCLAW_API_TOKEN` (static, fallback)
   3. Deno Deploy OIDC token (automatic on Deploy)
5. **Work loop** — the agent receives tasks, LLM responses, and tool results
   through the WebSocket. It stays connected until idle or restarted.

### Env vars injected into deployed agent apps

These are set automatically by the publish flow on the Deploy app:

| Env var                          | Source                                    |
| -------------------------------- | ----------------------------------------- |
| `DENOCLAW_AGENT_ID`             | Agent ID                                  |
| `DENOCLAW_BROKER_URL`           | Broker URL                                |
| `DENOCLAW_AGENT_URL`            | Agent's own public URL                    |
| `DENOCLAW_API_TOKEN`            | Broker auth token (if set)                |
| `DENOCLAW_BROKER_OIDC_AUDIENCE` | OIDC audience (only if differs from URL)  |

### Files involved

- `src/cli/publish.ts` — CLI publish command
- `src/cli/publish_entry.ts` — entrypoint generator
- `src/cli/deploy_api.ts` — Deno Deploy API v2 client
- `src/agent/deploy_runtime.ts` — agent boot + WS connect
- `src/agent/deploy_runtime_auth.ts` — auth resolution logic
- `src/orchestration/client.ts` — `BrokerClient`
- `src/orchestration/transport_websocket.ts` — `WebSocketBrokerTransport`
- `src/orchestration/broker/server.ts` — `BrokerServer`
- `src/orchestration/broker/agent_socket_upgrade.ts` — WS upgrade handler

---

## 4. Recommended operator workflow

1. Deploy and verify the broker first.
2. Confirm dashboard, `/health`, and broker logs are correct.
3. Set `DENOCLAW_BROKER_URL` locally (saved automatically by `deno task deploy`).
4. Publish the target agent.
5. Run a real broker → agent task and verify:
   - broker registers the endpoint
   - broker wake-up hits `/tasks`
   - the agent opens `/agent/socket` (check broker logs for WS connection)
   - LLM/tool requests flow back through the broker WebSocket

---

## 5. Local development

For local development, you don't need Deno Deploy at all:

```bash
deno task dev
```

This runs the broker as the main process, agents as Workers, and sandboxes as
subprocesses. See [Architecture](./architecture-distributed.md) for details on
local vs deploy mode.

Minimum local `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

---

## 6. Troubleshooting

### Broker boots the dashboard instead of the broker runtime

- Confirm `deno.json` still points to the broker app, not an agent app
- Confirm the broker app runtime was normalized by `deno task deploy`
- Re-run `deno task deploy`
- Inspect the app config in Deno Deploy: dynamic runtime, entrypoint
  `./main.ts`, args `["broker"]`

### `deno task publish` fails immediately

- Confirm `DENO_DEPLOY_ORG_TOKEN` is set
- Confirm the token is an **organization** access token (not a personal token)
- Confirm the token can create apps and revisions in the target org

### Agent publishes but doesn't execute

- Inspect broker logs for the agent's `/agent/socket` WebSocket connection
- Check the agent's `/tasks` wake-up endpoint is responding
- Compare agent logs and broker logs over the same timestamp window
- Do **not** assume the old KV transport is involved — all communication goes
  through WebSocket

### Agent revision fails during warm-up

- Inspect the revision through `GET /v2/revisions/{revision}`
- Confirm the revision contains the expected `env_vars`
- Inspect `GET /v2/revisions/{revision}/progress`

---

## 7. Auth status and roadmap

Current state (2026-03-30):

- Agent → Broker WebSocket auth prefers the shared static broker token
  (`DENOCLAW_API_TOKEN`) and falls back to OIDC if no static token is configured
- Broker → Agent wake-up uses the shared static bearer token
- OIDC is supported but treated as a fallback for now

What remains:

- Deciding whether broker → agent wake-up should move to a stronger broker
  identity flow
- Redesigning the agent WebSocket auth handshake if OIDC becomes the preferred
  path
- Longer-running streaming behavior once the live cycle is fully verified
