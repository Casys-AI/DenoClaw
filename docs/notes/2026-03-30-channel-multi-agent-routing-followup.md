# Channel Multi-Agent Routing Follow-up

## Status

Open design follow-up after the first `channel_ingress` unification pass.

## What is now true

The runtime is moving toward one canonical human-ingress boundary:

- `src/orchestration/channel_ingress/*`
- `src/orchestration/gateway/server.ts`
- `src/orchestration/broker/http_routes.ts`

Local human traffic now enters through the same conceptual task-ingress seam as
broker-backed human traffic.

## What remains open

When a human-facing channel receives a message and multiple agents exist, the
runtime still needs a clear routing model.

The unresolved product question is:

- does one channel message target exactly one agent
- or should one message fan out to multiple agents by default

## Current recommendation

Default to **one channel message -> one owning agent**.

If multiple agents need to collaborate, that should happen through
orchestration after ingress:

1. channel message enters the system
2. one agent is selected as the task owner
3. that agent may delegate to peers through canonical A2A flow
4. the channel still sees one coherent conversation

Do **not** default to fan-out/broadcast for normal channel traffic.

## Why this matters

Broadcast-by-default would create ambiguous runtime behavior:

- multiple competing replies to one human message
- duplicated tool calls and side effects
- multiple `INPUT_REQUIRED` pauses for the same channel turn
- unclear ownership of session/task state

That is a different product mode, not standard routing.

## Likely routing modes

### Standard mode

- one incoming channel message resolves to one agent
- resolution can come from session pinning, default-agent config, or explicit
  mention syntax such as `@agent`

### Orchestration mode

- one front agent owns the channel conversation
- it delegates internally to other agents when needed

### Broadcast mode

- opt-in only
- useful for swarm/review/debate workflows
- should be modeled explicitly as fan-out, not as the default channel router

## What to study next

- whether channel routing should be configured per channel, per session, or per
  thread
- whether mention-based routing is enough for the first multi-agent UX
- whether a dedicated front/router agent is the best default for shared human
  channels such as Telegram
- whether broadcast mode belongs in the core channel router or in a higher
  orchestration layer

## Guardrail

Keep the canonical mental model simple:

- `channel_ingress` accepts one human message
- one canonical task owner is chosen
- multi-agent collaboration happens above that layer, not instead of it
