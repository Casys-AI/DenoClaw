# ADR-015: Broker Federation — Agent Mesh Network

**Status:** Accepted **Date:** 2026-03-29

## Context

Today, connecting agents across separate DenoClaw instances (e.g. a main broker
and a client broker) requires assembling multiple external tools: Discord for
messaging, Tailscale for secure networking, socat for proxying, and a VPS as
relay. This stack is fragile, hard to onboard, and difficult to secure properly.
Adding a new broker to the network is a multi-day effort.

DenoClaw already has the protocol primitives: A2A for agent communication,
WebSocket tunnels for network connectivity, peers/acceptFrom for access control,
and Agent Cards for capability discovery. What's missing is a coherent model
that ties them together into a federation story.

## Decision

**DenoClaw brokers can form an explicit trust network.** Each broker is
sovereign and decides which agents it exposes and to whom. Connections are
bilateral, config-driven, and authenticated. No transitivity.

### Principles

1. **Trust network, not open mesh.** Every link between brokers is explicit and
   bilateral. If Broker A trusts Broker B, and B trusts C, that does NOT mean
   A trusts C. No implicit propagation.

2. **Sovereign control.** Each broker decides exactly which agents to expose.
   Agents cost money (LLM tokens), so exposure must be deliberate and
   configurable per peer.

3. **Capability exchange on connect.** When two brokers establish a tunnel, they
   exchange Agent Cards for their exposed agents. Each side knows what the other
   can do — skills, input/output modes, capabilities — not just agent names.

4. **Config-driven onboarding.** A new instance should be deployable with a
   federation config block and a pre-provisioned token. No manual tunnel
   commands, no external tooling.

### What this replaces

| Before (external stack)            | After (native DenoClaw)                |
| ---------------------------------- | -------------------------------------- |
| Discord for agent messaging        | A2A over tunnel (structured, typed)    |
| Tailscale + socat for network      | WebSocket tunnel (authenticated, TLS)  |
| VPS as relay                       | Broker-to-Broker direct tunnel         |
| Manual config per new broker       | Declarative federation config          |

### What this does NOT cover

- Replacing Discord as a human-facing channel (that's a channel concern, not
  federation)
- Matching Tailscale's WireGuard-level security (TLS is solid but different
  threat model — to revisit)
- Quotas and billing between peers (needed but separate concern)

## Consequences

- Onboarding a new client broker becomes: install DenoClaw + add federation
  config + share a token. Minutes instead of days.
- Agent collaboration across instances uses the same A2A protocol as local
  inter-agent communication. No protocol translation.
- Each broker remains fully autonomous. Federation is opt-in, per-agent,
  revocable.
- The tunnel replaces the Tailscale + socat + VPS stack for agent-to-agent
  networking, while keeping the same security posture (TLS + token auth +
  permission intersection).
