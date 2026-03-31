# Channel Multi-Agent Routing Follow-up

## Status

Re-opened design follow-up after the first `channel_ingress` unification pass.

## What is now true

The runtime is moving toward one canonical human-ingress boundary:

- `src/orchestration/channel_ingress/*`
- `src/orchestration/gateway/server.ts`
- `src/orchestration/broker/http_routes.ts`

Local human traffic now enters through the same conceptual task-ingress seam as
broker-backed human traffic.

Route planning is now explicit in code:

- local runtime accepts `ChannelRoutePlan`
- broker HTTP ingress accepts `ChannelRoutePlan`
- both support `direct`
- both support explicit `broadcast`

For broker-backed shared ingress, the model is now:

- one shared ingress task for the human-facing channel turn
- one routed agent task per target agent
- broker aggregation of agent task state/results onto the shared ingress task

The current config shape for ingress-scope routing is now explicit:

- `channels.telegram.accounts[]`
- Telegram account secrets can be referenced via `tokenEnvVar`
- `channels.routing.scopes[]`
- Telegram can match by `channelType` and optional bot `accountId`
- Discord can match by `channelType`, `roomId`, and optional `threadId`
- old root-level Telegram fields are now rejected explicitly during config load,
  so runtime routing only accepts the canonical accounts-based shape

## What remains open

When a human-facing channel receives a message and multiple agents exist, the
runtime still needs a clear routing model.

The important distinction is:

- a channel adapter owns transport and message normalization
- an ingress scope owns delivery policy
- orchestration owns higher-level delegation and coordination

Those are not the same decision.

## Current recommendation

Do **not** force one universal routing rule across all channel types.

The model needs to support at least two shapes:

1. **Direct ingress**
   - one message resolves to one primary target
   - example: Telegram bot onboarding (`bot -> agent`)
2. **Shared ingress**
   - one message can fan out to multiple subscribed agents
   - example: Discord guild/channel/thread with multiple internal agents

In other words:

- “one owner” is a valid policy for some ingress scopes
- it is **not** the universal rule for all human-facing channels
- `broadcast` should stay explicit, but explicit broadcast is still a
  first-class ingress policy

Concrete decisions so far:

- Telegram is effectively `1:1`, so implicit single-owner routing is fine there
- Discord/shared channels should not fan out by default
- Discord/shared channels can use explicit mention-based routing when multiple
  bots or multiple agents coexist in the same room

## Why this matters

Accidental broadcast-by-default would create ambiguous runtime behavior:

- multiple competing replies to one human message
- duplicated tool calls and side effects
- multiple `INPUT_REQUIRED` pauses for the same channel turn
- unclear ownership of session/task state

That is a deliberate ingress mode, not a fallback.

## Likely routing modes

### Direct ingress

- one incoming channel message resolves to one primary target
- resolution can come from session pinning, bot identity, default-agent config,
  or explicit mention syntax such as `@agent`

### Shared ingress

- one incoming channel message is delivered to multiple subscribed agents
- the ingress layer owns fan-out explicitly instead of pretending the message
  has a single canonical owner

### Orchestration strategy

- a front agent or router agent may still coordinate work above ingress
- `by-intent` belongs here, not as a raw channel transport mode

## What to study next

- whether ingress policy should be configured per bot, per channel scope, or per
  thread
- whether mention-based routing is enough for the first Discord/shared-channel
  multi-agent UX
- whether a dedicated front/router agent is the best default for some shared
  human channels
- how reply semantics and `INPUT_REQUIRED` behave in shared ingress mode
- how Discord adapter config resolves guild/channel/thread scope into a concrete
  shared route plan
- whether shared-ingress continuation should ever be modeled as a canonical
  single resume path, or stay intentionally non-canonical

## Guardrail

Keep the canonical mental model simple:

- `channel_ingress` accepts one human message
- routing policy is resolved at the ingress-scope level
- orchestration happens above ingress, not inside the transport adapter
