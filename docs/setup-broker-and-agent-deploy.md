# Broker and Agent Deploy Setup

This document is the operator-facing setup path for DenoClaw's deploy targets.
It separates the broker path from the agent path on purpose:

- Broker = Deno Deploy app
- Agents = Deno Deploy v2 apps and revisions

## Current status

As of 2026-03-30, these statements are true:

- The broker deployment path is source-controlled and should target
  `main.ts broker` on Deno Deploy.
- Agent publication should use the public Deno Deploy REST API at
  `https://api.deno.com/v2`.
- The public `v2` contract is `apps` + `revisions`, authenticated by an
  organization access token in the `Authorization: Bearer ...` header.
- Distributed agent-to-broker transport is wired in the repo; what remains is
  validation against real Deploy credentials and any follow-up hardening.

That means:

- You can deploy and verify the broker today.
- You can create and update per-agent Deploy apps today.
- You should still validate the live broker <-> agent cycle before treating the
  deploy path as production-proven.

## 1. Broker setup

### Prerequisites

- Deno 2.7+
- Access to the target Deno Deploy org
- A local Deno Deploy CLI login
- Provider API keys for any LLMs the broker must proxy

### Why the broker config lives in `deno.json`

This repository contains a dashboard under `web/` and a Vite/Fresh config under
`vite.config.ts`. If Deno Deploy is left to auto-detect the app shape, it can
pick the dashboard preset instead of the broker runtime.

To avoid that, the broker runtime is pinned in `deno.json`:

```json
{
  "deploy": {
    "runtime": {
      "type": "dynamic",
      "entrypoint": "main.ts",
      "args": ["broker"]
    }
  }
}
```

That forces Deno Deploy to boot the distributed broker entrypoint instead of
inferring a framework preset from the dashboard files or falling back to the
local gateway code path.

### Deploy the broker

From the repository root:

```bash
deno task check
deno task deploy
```

What `deno task deploy` does:

- ensures the Deno Deploy app exists
- creates it with an explicit dynamic runtime when needed
- uploads the current repo root
- relies on the source-controlled deploy config in `deno.json`

### Verify the broker

List env vars:

```bash
deno deploy env list --org <org> --app <app>
```

Check health:

```bash
curl -H "Authorization: Bearer <DENOCLAW_API_TOKEN>" \
  <broker-url>/health
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
  wake-up and as the static fallback when OIDC is unavailable.

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

## 3. Current runtime status

The distributed agent Deploy path is now wired in the repo.

Current behavior:

- `generateAgentEntrypoint()` boots `startDeployedAgentRuntime()`
- the broker stores agent config and public endpoint via `/agents/register`
- cold agents are woken by broker `POST /tasks`
- awake agents connect back to the broker over `/agent/socket`
- agent -> broker auth prefers OIDC and falls back to a static bearer token
- broker -> agent wake-up currently uses the shared static bearer token

Files involved:

- `src/cli/setup.ts`
- `src/cli/publish.ts`
- `src/agent/deploy_runtime.ts`
- `src/orchestration/client.ts`
- `src/orchestration/transport.ts`
- `src/orchestration/broker.ts`

What remains:

- real-condition validation against live Deno Deploy credentials
- deciding whether broker -> agent wake-up should stay on static bearer auth or
  move to a stronger broker identity flow
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

- confirm `deno.json` still contains `deploy.runtime.entrypoint = "main.ts"`
- confirm `deno.json` still contains `deploy.runtime.args = ["broker"]`
- re-run `deno task deploy`
- inspect the latest build in Deno Deploy and confirm the runtime config came
  from source code, not auto-detection

If `deno task publish` fails immediately:

- confirm `DENO_DEPLOY_ORG_TOKEN` is set
- confirm the token is an organization access token
- confirm the token can create apps and revisions in the target organization

If agent publication succeeds but remote execution does not:

- inspect broker registration, `POST /tasks`, and `/agent/socket` first
- do not assume the old KV transport is involved anymore
