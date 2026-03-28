# Broker Message Redesign Implementation Status

**Date:** 2026-03-29

**Goal:** finish the ADR-011 cleanup so the protocol stack has one coherent task
model and one strict tunnel contract.

## Completed

- broker legacy variants `agent_message`, `agent_response`, and `heartbeat` are
  removed from the orchestration contract
- broker types are split into `BrokerRuntimeMessage`, `BrokerTaskMessage`,
  `BrokerRequestMessage`, and `BrokerResponseMessage`
- local broker delivery still uses KV Queue when no tunnel is active, but task
  semantics stay canonical `task_*`
- `AgentRuntime` narrows incoming broker envelopes to canonical `task_submit` /
  `task_continue`
- runtime guard extraction lives in `src/agent/runtime_transport.ts`
- worker protocol terminology is now `infra` vs `execution`, with `run` /
  `peer_*` / `task_observe` replacing migration-era names
- local worker execution routes through `executeCanonicalWorkerTask()` and
  canonical A2A lifecycle mapping
- broker/relay tunnel now requires:
  - `Authorization: Bearer <invite-or-session-token>`
  - negotiated subprotocol `denoclaw.tunnel.v1`
  - explicit `idleTimeout`
  - fail-fast backpressure guards
- relay now consumes broker-issued `session_token` control messages and prefers
  session-token reconnect auth after the first successful handshake
- `/tunnel` no longer falls back to static token or generic `checkRequest()`
  auth paths
- tunnel control messages are now typed explicitly: `register`, `registered`,
  `session_token`
- broker no longer derives tunnel identity from `?id=` query parameters
- observability naming is aligned end-to-end on `task_observation` /
  `task_observations`

## Verified

Targeted protocol/runtime test batch passes:

```bash
deno test --unstable-kv \
  --allow-env=LOG_LEVEL,DENO_SANDBOX_API_TOKEN,HOME,USERPROFILE,DENOCLAW_API_TOKEN,DENOCLAW_DASHBOARD_AUTH_MODE,DENO_DEPLOYMENT_ID,DENOCLAW_DASHBOARD_GITHUB_ALLOWED_USERS,GITHUB_ALLOWED_USERS \
  --allow-read=/tmp,/var/folders/8z/7c5x0xvj47lbnm8rb3n_8_9m0000gn/T \
  --allow-write=/tmp,/var/folders/8z/7c5x0xvj47lbnm8rb3n_8_9m0000gn/T \
  src/orchestration/tunnel_protocol_test.ts \
  src/orchestration/relay_test.ts \
  src/orchestration/monitoring_test.ts \
  src/orchestration/gateway_test.ts \
  src/agent/runtime_transport_test.ts \
  src/agent/runtime_broker_task_test.ts \
  src/orchestration/types_test.ts \
  src/orchestration/client_test.ts \
  src/orchestration/broker_test.ts \
  src/agent/worker_protocol_test.ts \
  src/agent/worker_entrypoint_test.ts
```

Result at write time: `74 passed | 0 failed`

## Acceptance criteria status

- no broker/orchestration code path relies on legacy `agent_message` /
  `agent_response`: done
- `AgentRuntime` only processes canonical broker task envelopes: done
- local mode and tunnel mode preserve the same task semantics: done
- worker protocol no longer reads like a second task contract: done
- tunnel handshake is explicit, versioned, and fail-fast: done
- tunnel control frames and observability naming are coherent end-to-end: done

## Remaining follow-ups

- add richer tunnel telemetry around upgrade, register, backpressure rejection,
  and reconnect attempts
- fold this status note into an ADR follow-up if the repo wants the redesign
  recorded as a durable architecture decision
