# Agent WebSocket Auth Follow-up

## Status

Deferred on purpose after the first successful real broker/agent deploy path.

## What happened

For the deployed agent WebSocket connection (`agent -> broker`), the most
reliable path during real Deno Deploy testing was:

- prefer `DENOCLAW_API_TOKEN` / `DENOCLAW_BROKER_TOKEN`
- keep OIDC only as a fallback

This was chosen pragmatically to get the live `alice` agent revision healthy.

## Why OIDC was not kept first

OIDC is still the more secure target in principle:

- short-lived token
- platform-issued identity
- no long-lived shared secret copied everywhere

But with the current WebSocket transport shape, OIDC was more fragile in
practice:

- the agent WebSocket handshake had to carry the auth token during connect
- the OIDC token is a large JWT
- the static token path was the one that succeeded reliably in the real deploy
  test

## Current rule

For now, the deployed agent WebSocket path uses:

- static broker token first
- OIDC only if no static token is configured

This applies to the `agent -> broker` WebSocket transport only.

## Desired follow-up

Later, we should restore OIDC as the preferred secure model, but likely with a
different handshake design.

The likely cleaner shape is:

1. agent gets an OIDC token
2. agent calls a broker HTTP endpoint
3. broker verifies OIDC and mints a short-lived WS session token
4. agent opens the WebSocket with that short-lived token

That would preserve the security benefits of OIDC without depending on a large
raw JWT in the WebSocket connect path.

## Rule for now

For current real-world deploy tests:

- keep the static token as the primary agent WebSocket auth path
- do not redesign the auth handshake yet
- revisit only after broker/agent task execution is fully green end to end
