# Deno Native WebSocket Notes

**Date:** 2026-03-29

**Goal:** capture the native Deno WebSocket capabilities that matter for
DenoClaw, and record what is now implemented.

## Scope

This note covers the current WebSocket paths in:

- `src/orchestration/broker.ts`
- `src/orchestration/relay.ts`
- `src/orchestration/gateway.ts`
- `src/orchestration/monitoring.ts`

## What native Deno gives us

### 1. WebSocket subprotocol negotiation

Deno supports this natively:

- client side via `new WebSocket(url, { protocols: ... })`
- server side via `Deno.upgradeWebSocket(req, { protocol: ... })`

This is the right primitive to version the broker/relay tunnel contract.

### 2. Custom headers on the Deno WebSocket client

Deno's client constructor supports first-party `headers`.

This lets the relay authenticate with:

- `Authorization: Bearer <invite-or-session-token>`

instead of leaking credentials through the URL.

### 3. Explicit `idleTimeout`

`Deno.upgradeWebSocket()` exposes `idleTimeout`, so tunnel liveness does not
need to depend on an implicit runtime default.

### 4. Backpressure visibility via `bufferedAmount`

Native `WebSocket.bufferedAmount` makes it possible to reject slow or wedged
sockets before they accumulate unbounded queued data.

### 5. SSE for one-way monitoring

`kv.watch()` + SSE remains the right native choice for dashboard streaming. It
keeps WebSocket complexity focused on actual bidirectional tunnel paths.

### 6. `WebSocketStream`

Interesting, still unstable, not needed for the current shape.

## Current implemented state

### Broker / relay tunnel

The broker/relay path now uses native Deno WebSocket features in a strict way:

- canonical subprotocol: `denoclaw.tunnel.v1`
- strict handshake rejection when the subprotocol is missing
- strict handshake rejection when `Authorization: Bearer ...` is missing
- typed control frames for `register`, `registered`, and `session_token`
- tunnel identity derived from authenticated token identity instead of URL
  parameters
- explicit tunnel `idleTimeout`
- explicit backpressure rejection on saturated tunnel sends

There is no compatibility fallback on the tunnel handshake path.

### Relay client

The relay now:

- sends `Authorization` instead of query-string auth
- reuses broker-issued session tokens after the first successful handshake
- sends the canonical tunnel subprotocol during connection
- sends a strict typed `register` control frame
- validates the negotiated protocol on open
- rejects closed or saturated sockets before calling `send()`

### Gateway public WebSocket

The browser-facing `/ws` path now:

- uses explicit `idleTimeout`
- validates incoming payload shape strictly
- rejects binary frames
- closes saturated sockets instead of silently dropping into an overloaded state

### Monitoring

Dashboard realtime stays on:

- `kv.watch()` + SSE

That remains the correct native Deno choice for one-way updates.

## Recommendations that are now done

- move tunnel auth from query parameter to header
- negotiate a canonical broker/relay subprotocol
- make `idleTimeout` explicit
- add `bufferedAmount` guards on send paths

## Recommendations still worth doing later

- add richer telemetry around tunnel upgrade, registration, routing, reconnect,
  and close events
- revisit binary frames only if message volume or payload size makes JSON
  framing a measurable problem
- revisit `WebSocketStream` only if a streams-first relay implementation becomes
  desirable

## Non-goals

- do not replace SSE with WebSocket for monitoring
- do not introduce a third-party WebSocket framework
- do not redesign the protocol solely to chase binary framing

## Outcome

The useful native Deno WebSocket improvements were not exotic. They were:

- explicit versioning
- explicit auth
- explicit liveness
- explicit backpressure

Those are now in place on the tunnel path.
