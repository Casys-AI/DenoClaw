# Broker and Agent Deploy Setup

This document is the operator-facing setup path for DenoClaw's deploy targets.
It separates the broker path from the agent path on purpose:

- Broker = Deno Deploy app
- Agents = Deno Deploy v2 apps and revisions

Canonical deploy naming is defined separately in:

- `docs/adr-015-deploy-resource-naming.md`

Important:

- the current live deploys may still use older legacy names
- those names should not be treated as the long-term canonical convention

## Current status

As of 2026-03-30, these statements are true:

- The broker deployment path is source-controlled and targets `main.ts broker`
  on Deno Deploy.
- Agent publication should use the public Deno Deploy REST API at
  `https://api.deno.com/v2`.
- The public `v2` contract is `apps` + `revisions`, authenticated by an
  organization access token in the `Authorization: Bearer ...` header.
- The live broker deploy path is working.
- The live agent deploy path has been validated with `alice`.
- The current deployed agent WebSocket auth path is stable with a static broker
  token first and OIDC as a fallback.

That means:

- You can deploy and verify the broker today.
- You can create and update per-agent Deploy apps today.
- You can validate a real broker <-> agent cycle today.
- There is still follow-up hardening to do before calling the auth model final.

## 1. Broker setup

### Prerequisites

- Deno 2.7+
- Access to the target Deno Deploy org
- A local Deno Deploy CLI login
- Provider API keys for any LLMs the broker must proxy

### Why `deno.json` must stay broker-oriented

This repository contains a dashboard under `web/` and a Vite/Fresh config under
`vite.config.ts`. If Deno Deploy is left to auto-detect the app shape, it can
pick the dashboard preset instead of the broker runtime.

`deno.json` must not point at an agent app.

For the current live setup, it should stay broker-oriented. For the canonical
long-term naming convention, the broker app slug should be `denoclaw-broker`.

Current broker-oriented example:

```json
{
  "deploy": {
    "org": "casys",
    "app": "denoclaw-broker"
  }
}
```

The broker runtime itself is configured by the deploy flow through the Deno
Deploy API and CLI:

- dynamic runtime
- entrypoint `./main.ts`
- args `["broker"]`
- working directory `.`

That separation is intentional:

- `deno.json` stays broker-oriented at the repo level
- broker app runtime is configured explicitly during deploy
- agent apps are configured per app/revision through the `v2` API, not through
  `deno.json`
- stronger naming should be migrated intentionally, not by accident during a
  later deploy

### Deploy the broker

From the repository root:

```bash
deno task check
deno task deploy
```

What `deno task deploy` does:

- ensures the Deno Deploy app exists
- creates or normalizes the app with an explicit dynamic runtime when needed
- provisions and assigns the shared broker KV database
- syncs `DENOCLAW_API_TOKEN` and provider env vars to the broker app
- uploads the current repo root
- saves the deployed broker URL and KV database name into local config

### Verify the broker

List env vars:

```bash
deno deploy env list --org <org> --app <app>
```

Check public health:

```bash
curl <broker-url>/health
```

Check an authenticated endpoint:

```bash
curl -H "Authorization: Bearer <DENOCLAW_API_TOKEN>" \
  <broker-url>/stats
```

Read logs:

```bash
deno deploy logs --org <org> --app <app>
```

## 2. Agent Deploy setup

### Required credentials

Set these before publishing agents:

```bash
export DENO_DEPLOY_ORG_TOKEN=<org-access-token>
export DENOCLAW_BROKER_URL=<broker-url>
```

Optional but recommended:

```bash
export DENOCLAW_BROKER_OIDC_AUDIENCE=<oidc-audience>
export DENOCLAW_API_TOKEN=<shared-static-token>
```

Notes:

- `DENO_DEPLOY_ORG_TOKEN` is the canonical org-scoped Bearer token used by the
  public Deno Deploy `v2` API.
- `DENO_DEPLOY_PAT` is a separate personal token family and is not used for the
  agent publish flow.
- `DENOCLAW_BROKER_URL` is required so the published agent knows where to open
  its broker socket.
- `DENOCLAW_BROKER_OIDC_AUDIENCE` defaults to `DENOCLAW_BROKER_URL` when
  omitted.
- `DENOCLAW_API_TOKEN` is currently used for broker-authenticated `POST /tasks`
  wake-up and as the primary auth path for the deployed agent WebSocket.
- OIDC is still supported, but currently treated as a fallback for the agent
  WebSocket path until the handshake design is hardened.

### Publish one agent

```bash
deno task publish alice
```

### Publish all agents

```bash
deno task publish
```

The publish flow:

- loads agents from `data/agents/*`
- creates or reuses one Deploy app per agent
- uploads a generated `main.ts` entrypoint plus source assets
- creates a new revision through `POST /v2/apps/{app}/deploy`
- registers `agentId -> endpoint/config` back with the broker

Canonical target naming for future cleanup:

- broker app: `denoclaw-broker`
- agent app: `denoclaw-agent-<agent-id>`
- broker KV: `denoclaw-broker-kv`
- agent KV: `denoclaw-agent-<agent-id>-kv`
- sandbox instance: `denoclaw-agent-<agent-id>-sandbox`

Some currently live resources still use legacy names such as `denoclaw`,
`alice`, or `alice-kv`.

## 3. Current runtime status

The distributed agent Deploy path is now wired in the repo.

Current behavior:

- `generateAgentEntrypoint()` boots `startDeployedAgentRuntime()`
- the broker stores agent config and public endpoint via `/agents/register`
- cold agents are woken by broker `POST /tasks`
- awake agents connect back to the broker over `/agent/socket`
- the WebSocket transport first wakes the broker over HTTP, then retries the WS
  connect path briefly
- agent -> broker WebSocket auth currently prefers the shared static broker
  token and only falls back to OIDC if no static token is configured
- broker -> agent wake-up currently uses the shared static bearer token

Files involved:

- `src/cli/setup.ts`
- `src/cli/publish.ts`
- `src/agent/deploy_runtime.ts`
- `src/orchestration/client.ts`
- `src/orchestration/transport.ts`
- `src/orchestration/broker.ts`

What remains:

- deciding whether broker -> agent wake-up should stay on static bearer auth or
  move to a stronger broker identity flow
- redesigning the agent WebSocket auth handshake if we want OIDC to become the
  preferred secure path again
- longer-running streaming behavior once the first live cycle is verified

## 4. Recommended operator workflow

If someone on the project needs to set things up today, use this order:

1. Deploy and verify the broker first.
2. Confirm dashboard, `/health`, and broker logs are correct.
3. Set `DENOCLAW_BROKER_URL` locally before publishing agents.
4. Publish the target remote agent.
5. Run a real broker -> agent task and verify:
   - broker registers the endpoint
   - broker wake-up hits `/tasks`
   - the agent opens `/agent/socket`
   - LLM/tool requests flow back through the broker

## 5. Troubleshooting

If the broker deploy boots the dashboard instead of the broker:

- confirm `deno.json` still points to the broker app, not an agent app
- confirm the broker app runtime was normalized by `deno task deploy`
- re-run `deno task deploy`
- inspect the app config in Deno Deploy and confirm it is:
  - dynamic runtime
  - entrypoint `./main.ts`
  - args `["broker"]`
  - working directory `.`

If `deno task publish` fails immediately:

- confirm `DENO_DEPLOY_ORG_TOKEN` is set
- confirm the token is an organization access token
- confirm the token can create apps and revisions in the target organization

If agent publication succeeds but remote execution does not:

- inspect broker registration, `POST /tasks`, and `/agent/socket` first
- do not assume the old KV transport is involved anymore

If an agent revision fails during warm-up:

- inspect the revision directly through `GET /v2/revisions/{revision}`
- confirm the revision contains the expected `env_vars`
- inspect `GET /v2/revisions/{revision}/progress`
- compare agent logs and broker logs over the same timestamp window
