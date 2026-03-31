# Channel Routing Cleanup Plan

## Problem

The current model mixes three different concerns:

- channel transport adapters
- ingress delivery policy
- orchestration strategy

Today, `channelRouting` lives on `AgentEntry`, which is too coarse for cases
like:

- Telegram: one onboarded bot maps to one direct target
- Discord: one shared scope may deliver to multiple subscribed agents

That placement makes it easy to encode contradictory agent-local settings for
the same ingress scope.

## Decisions

### 1. Separate transport from routing policy

- `TelegramChannel`, `DiscordChannel`, `WebhookChannel`, `ConsoleChannel` own
  transport concerns only
- they normalize inbound messages into canonical `ChannelMessage`
- they do not decide higher-level fan-out/orchestration policy by themselves

### 2. Model routing at ingress-scope level

Routing policy belongs to the scope that receives the human message, for
example:

- a Telegram bot identity
- a Discord guild/channel/thread
- a webhook endpoint or room

That scope decides whether ingress is:

- `direct`
- `broadcast`
- later, possibly `round-robin`

### 3. Keep orchestration above ingress

- `by-intent`
- router/front-agent patterns
- peer delegation after ingress

These are orchestration strategies, not transport modes.

### 4. Telegram and Discord do not need the same rule

- Telegram onboarding can stay `direct` by default: `bot -> primary agent`
- Discord shared scopes can legitimately be `broadcast`
- external third-party bots in the same Discord room are out of scope

## Migration shape

### Phase 1

- introduce explicit ingress routing types:
  - scope
  - delivery mode
  - target set
  - optional primary owner
- stop treating `message.metadata.agentId` as the intended long-term contract

### Phase 2

- remove `AgentEntry.channels`
- remove `AgentEntry.channelRouting`
- derive the real ingress policy table only from `channels.routing.scopes[]`

### Phase 3

- Telegram adapter resolves bot binding into a `direct` route plan
- Discord adapter resolves guild/channel/thread binding into a shared route plan
- runtime defines reply and `INPUT_REQUIRED` semantics for shared delivery

## Progress

### Completed in this cleanup branch

- `channel_ingress` now uses an explicit `ChannelRoutePlan` instead of a fake
  single `agentId`
- local runtime supports both:
  - `direct`
  - `broadcast`
- broker HTTP ingress also accepts both:
  - `direct`
  - `broadcast`
- broker `broadcast` is implemented as:
  - one shared ingress task visible to the caller
  - one agent task per routed target
  - explicit aggregation of agent `task_result` updates back onto the shared
    ingress task
- ingress-scope config now has a concrete persisted shape:
  - `channels.telegram.accounts[]`
  - each Telegram account entry declares:
    - `accountId`
    - `tokenEnvVar` or `token`
    - optional `allowFrom`
  - `channels.routing.scopes[]`
  - each scope entry declares:
    - `scope.channelType`
    - optional `scope.accountId`
    - optional `scope.roomId`
    - optional `scope.threadId`
    - `delivery`
    - `targetAgentIds`
- `ChannelManager` now supports multiple adapters of the same `channelType` and
  selects outbound delivery by `address.accountId` when needed
- config loading now accepts only the canonical Telegram shape:
  `channels.telegram.accounts[]`
- old root-level Telegram fields are rejected explicitly instead of being
  migrated silently

### Still intentionally explicit / not implemented

- broker/shared ingress continuation is **not** modeled as a single canonical
  resume path yet
- `/ingress/tasks/:id/continue` remains `direct`-only
- Discord-specific scope resolution and onboarding policy are still a separate
  adapter/config step

## Immediate code work

1. Add dedicated routing-policy types outside `AgentEntry`
2. Correct docs that imply `ChannelManager` already owns these reassignments
3. Stop documenting “one owner per message” as a universal invariant
4. Only then refactor runtime routing around a route-plan object

## Guardrails

- keep broker-first ingress
- keep transport adapters thin
- do not hide broadcast behind a fake single-owner contract
- do not move orchestration strategy into transport config
