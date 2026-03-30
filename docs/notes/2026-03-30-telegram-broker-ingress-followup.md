# Telegram Broker Ingress Follow-up

## Status

Deferred on purpose after the first successful real broker/agent deploy path.

## What is already true

Telegram already exists in the codebase as a human-facing channel:

- `src/messaging/channels/telegram.ts`
- `src/messaging/bus.ts`
- `src/orchestration/gateway/server.ts`

This is the right architectural role:

- human ingress via Telegram
- machine ingress via broker API
- runtime broker <-> agent transport kept separate

## What is missing

The current Telegram flow is wired into the local Gateway runtime, not into the
deployed broker runtime.

Today, the deployed broker handles:

- broker <-> agent socket transport
- agent registration
- broker-authenticated internal routing

But it does not yet expose the human ingress path that Telegram needs.

## Why this matters

Without this follow-up, the architecture is conceptually correct but not fully
closed in production:

- Telegram is the intended human channel
- but deployed traffic still lacks the canonical Telegram -> broker ingress

## Desired shape

Keep the separation explicit:

- Telegram remains a human channel
- broker public API remains the machine-facing entrypoint
- A2A stays on its own authenticated transport

The likely production shape is:

1. Telegram receives the human message
2. message is normalized into `ChannelMessage`
3. broker resolves the target agent/session
4. broker submits canonical task(s) to the agent runtime
5. reply is sent back to Telegram

## Guardrails

- Do not collapse Telegram into the broker <-> agent transport layer
- Do not use Telegram as a substitute for machine API ingress
- Keep human auth/routing concerns separate from A2A auth concerns

## Follow-up

Add a canonical deployed ingress path for Telegram so that:

- local/dev still supports lightweight channel testing
- deployed mode supports Telegram as the real human-facing channel
- the human/machine/runtime separation already described in the docs is
  actually enforced by the production runtime
