# ADR-003: Auth — OIDC + Credentials Materialization Wherever Possible

**Status:** Accepted **Date:** 2026-03-26

## Context

The DenoClaw architecture has several authentication boundaries:

- Broker → Deno Deploy agent apps + Sandbox API (lifecycle management)
- Broker → LLM API (Anthropic, OpenAI, etc.)
- Tunnel → Broker (machines/VPS connecting as nodes)
- **Agent (Deploy app) → Broker** (the agent calls the broker over HTTP for LLM,
  tools, A2A)
- Sandbox → Broker (code executed in Sandbox communicates with the broker)

The goal is to minimize static secrets. Every static secret is a risk (leakage,
missed rotation, non-revocable access).

## Decision

Use **@deno/oidc** and **credentials materialization** wherever it is
technically possible. Static secrets are a last resort.

## Per-Boundary Application

### Broker → Deno Sandbox API: `@deno/oidc`

The broker runs on Deno Deploy. It uses `@deno/oidc` to authenticate to the
Sandbox API without a static token. The OIDC token proves the Deploy app's
identity, is ephemeral, and renews automatically.

- Eliminates: `DENO_SANDBOX_API_TOKEN`
- The broker does not need to store this secret

### Tunnel ↔ Broker: ephemeral OIDC token

When a tunnel connects to the broker:

1. The tunnel identifies itself to the broker
2. The broker verifies identity via OIDC (if the tunnel also runs on Deploy) or
   via challenge/response
3. The broker issues an ephemeral token for the WebSocket session
4. No static shared secret exists between the tunnel and the broker

For local tunnels (not on Deploy), the broker issues a single-use invite token.
The tunnel uses it for the initial connection, then receives an ephemeral
session token.

### Agent (Deploy app) → Broker: `@deno/oidc` (preferred)

The deployed agent calls the Broker over HTTP (`fetch()`) for LLM, tools, and
A2A requests. It authenticates via OIDC — the same mechanism used by the Broker
for the Sandbox API.

```typescript
// Agent side (Deploy app)
const token = await getIdToken(brokerUrl); // @deno/oidc, ephemeral 5 min
await fetch(brokerUrl + "/llm", {
  headers: { "Authorization": `Bearer ${token}` },
  body: JSON.stringify({ model: "...", messages: [...] }),
});
```

```typescript
// Broker side — verification
// Verifies JWKS signature (https://oidc.deno.com/.well-known/jwks.json)
// Verifies org_id = our organization
// Verifies app_id = a registered agent
// Verifies aud = broker URL
// Verifies exp > now
```

The Broker identifies the agent via `app_id` (stable, does not change on
redeploy) and `org_id` (our organization).

**Fallbacks if OIDC is unavailable in the deployed agent app runtime:**

1. **Layers (API v2)** — the Broker injects a rotating token via the Layers
   feature, without redeploying
2. **Invite token → session token** — already implemented in `auth.ts`

**Locally**: no auth, `postMessage` is internal to the process.

### Sandbox → Broker: Credentials materialization

Code executed in Sandbox is potentially untrusted (skills, LLM-generated code).
It must authenticate to the broker, but it must NEVER see its own token.

With credentials materialization:

- The code uses a placeholder: `Bearer {{AGENT_TOKEN}}`
- The Sandbox platform injects the real value **only** on outbound requests to
  the broker URL
- The code cannot read, log, or exfiltrate the token
- Even malicious code inside Sandbox cannot extract the secret

Combined with the network allowlist (Sandbox can only talk to the broker), this
provides double protection.

### Broker → LLM API: via GCP Secret Manager (see ADR-004)

LLM API keys are stored in **GCP Secret Manager**. The broker retrieves them via
OIDC (Deno Deploy is a native OIDC provider → Workload Identity Federation →
Service Account → Secret Manager).

**There are no static secrets left in the architecture.** See ADR-004 for
details.

## Summary

| Boundary                                 | Mechanism                                            | Static secret?         |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------- |
| Broker → Deploy agent apps + Sandbox API | `@deno/oidc`                                         | No                     |
| **Agent (Deploy app) → Broker**          | **`@deno/oidc`** (preferred), Layers/invite fallback | **No**                 |
| Tunnel → Broker                          | Ephemeral OIDC / invite token                        | No                     |
| Sandbox → Broker                         | Credentials materialization                          | No (invisible to code) |
| Broker → LLM API                         | GCP Secret Manager via OIDC (ADR-004)                | **No**                 |
| Local (Worker → Main)                    | None (internal postMessage)                          | N/A                    |

## Consequences

- The static-secret surface is reduced to one point: LLM API keys on the broker
- Agent tokens are ephemeral and invisible to code → no exfiltration risk
- Token rotation is automatic (OIDC) or managed by the broker (session tokens)
- Added complexity: the OIDC flow and credentials materialization flow must be
  implemented
- Dependency: `@deno/oidc` is specific to Deno Deploy — if the broker moves off
  Deploy, another OIDC mechanism will be required
