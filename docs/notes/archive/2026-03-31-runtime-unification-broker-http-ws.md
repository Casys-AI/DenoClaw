# Runtime Unification Around Broker HTTP/WS

## Decision Direction

The target runtime model should be unified around the current broker-first
HTTP/WebSocket architecture:

- broker handles canonical task routing
- agents receive work via WebSocket when connected
- agents wake up via HTTP when idle
- replies flow back through the broker over the same routing model

This should be the primary model for both:

- Deno Deploy v2
- self-hosted / local networked deployments

## Why

The broker↔agent runtime path has now been cleaned up to avoid KV queue
fallbacks. That leaves the channel/gateway side as the remaining older path.

Keeping a second queue-based runtime model would add:

- different delivery semantics
- duplicated routing logic
- more test surface
- more platform-specific failure modes

## What This Means

Self-hosted should converge on the same logical runtime as Deploy:

- same ingress contracts
- same canonical task flow
- same privilege elevation behavior
- same broker-owned routing decisions
- same wake-up semantics

The goal is not necessarily identical process topology, but identical runtime
contracts and routing behavior.

## MessageBus Position

`MessageBus` currently remains queue-based and should not be treated as the
target runtime model.

Short term:

- treat `MessageBus` as legacy/self-hosted plumbing
- do not expand its role

Next step:

- redesign channel delivery so it converges on broker/channel ingress rather
  than KV queue semantics

## Follow-up

When this work starts, the first cleanup should be:

1. map current `Gateway`/`MessageBus` flows to broker ingress equivalents
2. remove queue-specific assumptions from channel delivery
3. keep local/self-hosted runnable without introducing a second runtime model
