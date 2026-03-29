# Draft: Broker Federation — Agent Mesh Network

## Context

Deploying new DenoClaw instances for clients requires manual tunnel setup and
peer configuration to connect agents across brokers. The main pain point: a
"manager" agent on the main broker needs to be reachable by client instances,
and vice versa. Today this means manual tunnel commands, manual peers/acceptFrom
config, no capability discovery.

The goal: make connecting brokers (and their agents) as easy as dropping a
config block.

## Current State

What exists today:
- Tunnel type `instance` (Broker <-> Broker over WebSocket) — **implemented**
- A2A routing cross-broker via `findTunnelByAgentId()` — **implemented**
- `peers`/`acceptFrom` per agent — **implemented**
- Agent Cards at `/.well-known/agent-card.json` — **implemented**
- Bearer token auth on tunnel handshake — **implemented**

What's missing:
- Agent Cards not exchanged during tunnel handshake (only agent names)
- No declarative federation config (manual tunnel setup)
- No auto-connect on boot
- No quotas/rate-limit per federated peer

## Design Principles

1. **Trust network, not open mesh** — every link is explicit, bilateral,
   configured. No transitivity (A trusts B, B trusts C, does NOT mean A trusts C)
2. **Sovereign control** — each broker decides exactly which agents to expose
   and to whom. Agents cost money (LLM tokens), exposure must be deliberate
3. **Card exchange on connect** — when two brokers establish a tunnel, they
   exchange full Agent Cards for exposed agents (not just names). Each side
   knows what the other can do (skills, input/output modes)
4. **Config-driven** — a new client instance should be deployable with just a
   federation config block + a pre-provisioned invite token

## Proposed Federation Config

```yaml
# In agent config (per-instance)
federation:
  peers:
    - url: wss://main-broker.deno.dev/tunnel
      token: "dcl_invite_xxxxx"       # invite or long-lived token
      expose: ["support", "onboarding"]  # agents this broker shares
      accept: ["manager", "billing"]     # agents this broker consumes

    - url: wss://partner-broker.deno.dev/tunnel
      token: "dcl_invite_yyyyy"
      expose: ["support"]
      accept: ["analytics"]
```

## Tunnel Handshake Extension

Today's register message:
```typescript
{
  type: "register",
  tunnelType: "instance",
  agents: ["support", "onboarding"],  // just names
}
```

Proposed extension:
```typescript
{
  type: "register",
  tunnelType: "instance",
  agents: ["support", "onboarding"],
  agentCards: {                         // full cards for discovery
    "support": { name, skills, capabilities, ... },
    "onboarding": { name, skills, capabilities, ... },
  },
  accept: ["manager", "billing"],       // what we want to consume
}
```

Broker responds with its own exposed cards:
```typescript
{
  type: "registered",
  tunnelId: "xxx",
  agentCards: {                         // cards for agents we can consume
    "manager": { name, skills, capabilities, ... },
    "billing": { name, skills, capabilities, ... },
  },
}
```

## Connection Flow (New Client Deployment)

```
1. Deploy client instance with federation config
2. On boot, Broker reads federation.peers[]
3. For each peer: open WebSocket tunnel, authenticate with token
4. Exchange register messages with agent cards
5. Both sides update their federated agent registry
6. Agents can now target cross-broker peers via standard A2A
7. peers/acceptFrom enforced as usual
```

## Open Questions

- **Quotas**: should there be a per-peer rate limit or token budget? Agents
  cost money. A rogue peer could rack up costs. Probably needed but can come
  later.
- **Card refresh**: if an agent's skills change, how to propagate? Options:
  periodic re-exchange, or push notification over the tunnel.
- **Invite tokens**: one-shot (consume on first connect) vs long-lived
  (reconnect after restart)? Probably long-lived with revocation.
- **Health/presence**: should brokers notify peers when agents go up/down?
  Or just let task submission fail with a clear error?
- **Dashboard visibility**: show federated agents in the dashboard? Useful
  but not blocking.
- **Transitivity**: explicitly NOT supported for now. Revisit only if real
  use case emerges.

## Use Cases

1. **Client onboarding**: deploy client broker with federation config pointing
   to main broker. Client's "support" agent can call "manager" immediately.
2. **Team collaboration**: each team member runs their own broker, federates
   specific agents with teammates.
3. **Microservices-style**: specialized brokers (one for code, one for research,
   one for ops) federated into a collaborative network.

## Status

**Exploratory** — capturing ideas from discussion. Not yet an ADR.
Architecture and protocol foundation already exists. Main work is:
config-driven auto-connect, card exchange in handshake, and operational tooling.
