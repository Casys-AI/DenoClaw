# Broker Message / Tunnel Protocol Redesign

**Date:** 2026-03-29

**Goal:** make the orchestration stack tell one protocol story:

- A2A owns task semantics
- broker envelopes own routing/runtime dispatch
- worker protocol owns only local execution plumbing
- tunnel transport is strict and versioned

## Architectural rules

### 1. Task semantics live in canonical A2A-shaped broker messages

Messages that describe agent work use canonical broker task operations:

- `task_submit`
- `task_continue`
- `task_get`
- `task_cancel`
- `task_result`

The broker stores and routes these messages without inventing a second task
model.

### 2. Broker envelopes carry routing and runtime requests only

Broker runtime messages remain broker-scoped plumbing:

- `llm_request`
- `llm_response`
- `tool_request`
- `tool_response`
- `error`

This keeps task semantics separate from execution/runtime dispatch.

### 3. Worker protocol is internal execution plumbing

The local worker path no longer exposes migration-era names such as `process` or
`agent_*`.

The internal worker transport is now split as:

- `infra`: `init`, `ask_response`, `shutdown`, `ready`, `ask_approval`,
  `task_started`, `task_completed`
- `execution`: `run`, `run_result`, `run_error`, `peer_send`, `peer_deliver`,
  `peer_response`, `peer_result`, `task_observe`

These names are intentionally runtime-local. They do not define a second task
contract.

### 4. Tunnel transport is fail-fast and versioned

The broker/relay tunnel now has an explicit contract:

- `Authorization: Bearer <invite-or-session-token>` is required
- `Sec-WebSocket-Protocol: denoclaw.tunnel.v1` is required
- the first relay frame must be a valid typed `register` control message
- broker-issued `session_token` / `registered` control messages are parsed
  strictly
- tunnel identity comes from authenticated token identity, not URL query
  parameters
- broker and relay both enforce explicit idle timeout / backpressure behavior
- static token, query-string auth, and protocol-less tunnel handshakes are not
  accepted on `/tunnel`

This is an intentional fail-fast boundary, not a migration window.

## Implemented state

- broker legacy variants `agent_message`, `agent_response`, and `heartbeat` are
  removed from the orchestration contract
- `BrokerMessage` is split into `BrokerRuntimeMessage`, `BrokerTaskMessage`,
  `BrokerRequestMessage`, and `BrokerResponseMessage`
- `AgentRuntime` only accepts canonical broker task envelopes via
  `runtime_transport.ts`
- local worker execution routes through canonical task lifecycle reporting in
  `executeCanonicalWorkerTask()`
- worker protocol terminology has been narrowed to `infra` vs `execution`
- relay auth uses headers, not query parameters
- relay reconnect auth prefers broker-issued session tokens once available
- tunnel handshake requires the canonical subprotocol and rejects broader auth
  fallbacks
- tunnel control frames are typed and validated explicitly
- task observability is now named `task_observe` in the worker protocol and
  `task_observation` in dashboard/SSE payloads

## Outcome

The stack is now legible without compatibility storytelling:

- A2A task semantics
- broker transport/runtime envelopes
- worker execution plumbing
- strict tunnel contract

That is the coherence target this redesign was meant to reach.
