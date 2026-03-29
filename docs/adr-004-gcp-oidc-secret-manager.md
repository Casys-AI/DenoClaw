# ADR-004: Zero Static Secrets — GCP Secret Manager via Deno Deploy OIDC

**Status:** Accepted (optional — Deploy env vars are enough to get started)
**Date:** 2026-03-27

## Context

ADR-003 concluded that LLM API keys (Anthropic, OpenAI, etc.) were the
**only static secret** left in the architecture, stored as encrypted env vars on
Deno Deploy. Everything else used OIDC or credentials materialization.

However, Deno Deploy is a **native OIDC provider**. It can issue ephemeral OIDC
tokens that prove the app's identity (organization, project, context). Those
tokens can be exchanged for GCP credentials through Workload Identity
Federation.

## Decision

**Store LLM API keys in GCP Secret Manager.** The broker retrieves them via
runtime OIDC — no static secrets anywhere.

## Flow

```
Broker (Deno Deploy)                    GCP
     │                                    │
     │  @deno/oidc                        │
     │  → ephemeral OIDC token            │
     │  "I am denoclaw-broker,            │
     │   org xyz, on Deploy"              │
     │                                    │
     ├──── OIDC token ──────────────────►│
     │                                    │ Workload Identity Federation
     │                                    │ verifies the token
     │                                    │ maps to a service account
     │◄──── temporary GCP credentials ────┤
     │                                    │
     ├──── Secret Manager API ───────────►│
     │     "give me ANTHROPIC_API_KEY"    │
     │◄──── "sk-ant-..." ────────────────┤
     │                                    │
     │  fetch() to Anthropic API          │
     │  using the retrieved key           │
```

## GCP Configuration — Setup integrated into the CLI

The `denoclaw publish gateway` command guides setup in 3 steps:

### Step 1: Deploy

```bash
deployctl deploy --project=denoclaw-gateway --prod main.ts
```

### Step 2: GCP OIDC connection (automated)

```bash
deno deploy setup-gcp --org=my-org --app=denoclaw-gateway
```

This interactive command configures:

- **Workload Identity Pool** — trusts Deno Deploy as an OIDC provider
- **Service Account** — with `secretmanager.secretAccessor` access
- Then enter the Workload Provider ID + Service Account Email in the Deploy
  dashboard

### Step 3: Secrets in Secret Manager

```bash
# Gateway access token
echo -n "my-token" | gcloud secrets versions add DENOCLAW_API_TOKEN --data-file=-

# LLM API keys
echo -n "sk-ant-..." | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-
echo -n "sk-..."     | gcloud secrets versions add OPENAI_API_KEY --data-file=-
```

Stored secrets:

- `DENOCLAW_API_TOKEN` — gateway access token
- `ANTHROPIC_API_KEY` — Anthropic API key
- `OPENAI_API_KEY` — OpenAI API key
- etc.

## Result: zero static secrets

| Boundary             | ADR-003 (before)            | ADR-004 (now)                    |
| -------------------- | --------------------------- | -------------------------------- |
| Sandbox → Broker     | Credentials materialization | Unchanged                        |
| Broker → Sandbox API | `@deno/oidc`                | Unchanged                        |
| Tunnel → Broker      | Ephemeral OIDC              | Unchanged                        |
| Broker → LLM API     | **Static env var key**      | **GCP Secret Manager via OIDC**  |
| VPS CLI auth         | Local CLI token             | Unchanged (one-shot tunnel auth) |

**There are no static secrets left anywhere in the architecture.**

## Rationale

- **Zero static secrets** — even LLM API keys are no longer stored in env vars
- **Automatic rotation** — change a key in Secret Manager and all brokers pick
  it up on the next call
- **Audit trail** — GCP logs every Secret Manager access
- **Instant revocation** — disabling the service account cuts access to all
  secrets
- **No leak path** — keys are never in code, git, env vars, or Deploy logs

## Consequences

- Dependency on GCP — the broker needs GCP to retrieve keys
  (mitigation: in-memory TTL cache)
- Startup latency — first Secret Manager call when the broker boots (~100ms)
- Initial configuration — Workload Identity Pool + Service Account + Secrets
  must be set up once
- The broker can cache keys in memory with a TTL (for example 1h) to avoid a
  Secret Manager call on every LLM request

## Degraded Mode

If GCP is down or not configured, the broker can fall back to standard Deploy
env vars. OIDC + Secret Manager is the recommended production mode, not a hard
requirement.
