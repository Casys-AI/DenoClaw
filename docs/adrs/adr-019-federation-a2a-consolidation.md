# ADR-019: Federation A2A Consolidation

**Status:** Accepted **Date:** 2026-04-01

## Context

ADR-011 established A2A as the canonical internal and external contract for
agent work. The external HTTP surface (`A2AServer` / `A2AClient`) was already
A2A-compliant, but the federation layer carried several inconsistencies:

- `RemoteAgentCatalogEntry.card` was typed `Record<string, unknown>` and always
  stored as `{}` — no real AgentCard ever propagated through federation.
- `federation_catalog_sync` only carried agent IDs (`string[]`), not structured
  entries with discovery metadata.
- Peer-to-peer messaging (`sendToAgent`) returned raw `string`, not an
  A2A-shaped result with task correlation.
- The SSE streaming endpoint emitted a custom `{ kind: "task" }` first frame
  not defined in the A2A spec.
- Deprecated `message` aliases coexisted with canonical field names
  (`initialMessage`, `taskMessage`, `statusMessage`, `continuationMessage`)
  across four core interfaces.
- SEC-19: instance tunnel registration called `syncCatalog()` without verifying
  the remote broker's identity, allowing an untrusted tunnel to inject catalog
  entries.

## Decision

Consolidate the federation and peer messaging layers to be fully A2A-shaped at
the payload level, while preserving the internal `BrokerMessage` WebSocket
transport (ADR-011).

### Changes made

**1. Typed AgentCards in federation catalog**

`RemoteAgentCatalogEntry.card` changed from `Record<string, unknown>` to
`AgentCard | null`. The `FederationDiscoveryPort.getRemoteAgentCard` return type
follows. All adapters (KV, tunnel) and tests updated.

**2. AgentCard propagation through catalog sync**

`FederationCatalogSyncPayload.agents` now accepts both legacy `string[]` and
structured `{ agentId: string; card?: AgentCard }[]`. The handler in
`federation_control_handlers.ts` parses both formats. Remote brokers can now
advertise their agents' full capabilities.

**3. SEC-19: Identity verification before catalog sync**

`tunnel_upgrade.ts` now calls `service.getIdentity(tunnelId)` before
`syncCatalog()`. Catalog is only accepted if the broker identity exists and has
`status: "trusted"`. Untrusted tunnels still register (socket stays open) but
their catalog is rejected with a warning log.

**4. Structured peer messaging**

`sendToAgent` now returns `PeerResult { content: string; taskId?: string }`
instead of `string`. The `peer_response` worker protocol message carries
`taskId` from the pending request. `SendToAgentFn` and `SendToAgentTool` updated
accordingly.

**5. SSE spec compliance**

The custom `{ kind: "task", ...task }` first SSE frame in `A2AServer.handleStream`
replaced with a spec-compliant `{ kind: "taskStatusUpdate", taskId, status, final: false }`
event with state `SUBMITTED`.

**6. Deprecated alias removal**

Removed the deprecated `message` field from:
- `CanonicalTaskInit` (use `initialMessage`)
- `TaskTransitionOptions` (use `statusMessage`)
- `BrokerTaskSubmitPayload` (use `taskMessage`)
- `BrokerTaskContinuePayload` (use `continuationMessage`)
- `RuntimeTaskSubmitPayload` (use `taskMessage`)
- `RuntimeTaskContinuePayload` (use `continuationMessage`)
- `SubmitTaskRequest` / `ContinueTaskRequest` in `runtime_port.ts`

Fallback logic in extractor functions removed. Legacy compatibility test deleted.

## What was NOT changed

- Internal transport remains `BrokerMessage` envelopes over WebSocket (ADR-011
  boundary preserved).
- No A2A JSON-RPC endpoint exposed on the broker's public surface. The
  `A2AServer` class exists standalone but is not wired into the gateway.
- No broker-to-broker outbound dial implemented. Federation routing still
  requires a pre-existing tunnel connection.
- Push notification methods (`tasks/pushNotificationConfig/set/get`) still
  unimplemented (returns `UNSUPPORTED_OPERATION`).

## Consequences

### Positive

- Federation catalog is type-safe end-to-end — `AgentCard` or explicit `null`.
- Remote agent discovery carries real capabilities, not empty objects.
- Peer messaging is correlatable by `taskId`, aligning with A2A tracing.
- SSE streaming is fully A2A-spec-compliant — interoperable with external
  clients.
- No more deprecated aliases — one canonical name per field, no fallback logic.
- SEC-19 closed — untrusted tunnels cannot inject catalog entries.

### Negative / cost

- Legacy `string[]` format still accepted in `federation_catalog_sync` for
  backward compatibility. Can be removed once all tunnel implementations send
  structured entries.
- `PeerResult` is a DenoClaw-specific type, not an A2A `Task`. Full alignment
  of peer messaging to A2A Tasks would require routing through `message/send`,
  which is a larger scope change.

## Related

- ADR-011: A2A as canonical internal/external contract
- ADR-006: A2A inter-agent protocol
- SEC-19: Tunnel catalog sync bypasses ECDSA signature verification
