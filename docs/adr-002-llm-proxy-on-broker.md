# ADR-002 : LLM Proxy centralisé sur le Broker — Clé API + OAuth

**Statut :** Accepté **Date :** 2026-03-26

## Contexte

Les agents tournent en Subhosting (ADR-001). Ils appellent le Broker par HTTP
pour tout : LLM, tools, A2A. Les Sandboxes (code execution) n'ont accès à aucun
secret. Les LLM nécessitent une authentification — que ce soit des clés API
(Anthropic, OpenAI) ou des tokens OAuth (flow navigateur, comme Claude CLI /
Codex CLI).

Les agents ne se parlent jamais directement (pas d'URL publique). Tout passe par
le Broker. Le tunnel est le mesh réseau de DenoClaw — il connecte brokers,
noeuds et machines, à la manière de Tailscale.

## Décision

**Le Broker (Deno Deploy) est le routeur central pour TOUT ce qui sort d'un
agent** : calls LLM, exécution d'outils, et communication inter-agents. Le
tunnel WebSocket est un primitif de premier ordre.

### Deux modes d'authentification LLM

Les deux modes font `fetch()` vers l'API LLM au final. Seule la méthode d'auth
change.

**Mode Clé API** — pour les providers avec clé statique (Anthropic, OpenAI,
DeepSeek, etc.)

- Le broker détient les clés API (env vars Deploy ou GCP Secret Manager,
  ADR-004)
- L'agent demande une completion, le broker fait le `fetch()` avec la clé

**Mode OAuth** — authentification navigateur (même flow que Claude CLI / Codex
CLI)

- Le broker initie un flow OAuth/device code
- Le tunnel route l'URL d'auth vers la machine locale → l'utilisateur se
  connecte dans son navigateur (one-shot)
- Le broker stocke le token OAuth (KV ou Secret Manager)
- Les appels LLM suivants utilisent `fetch()` avec le token OAuth — comme le
  mode clé API

Les deux modes sont transparents pour l'agent — interface uniforme
`broker.complete()`.

## Flux — Appel LLM (identique pour les deux modes d'auth)

```
Agent (Subhosting)               Broker (Deploy)              API LLM
     │                                │                          │
     │  POST /llm { messages, model } │                          │
     ├──── HTTP (OIDC auth) ─────────►│                          │
     │                                │  + injecte clé API       │
     │                                │    ou token OAuth         │
     │                                ├─── fetch() ─────────────►│
     │                                │◄── response ─────────────┤
     │◄── HTTP response ──────────────┤                          │
     │  { content, toolCalls }        │                          │
```

L'agent ne sait pas quel mode d'auth est utilisé — interface uniforme
`broker.complete()`.

## Auth initiale OAuth (one-shot)

Quand le Broker n'a pas de clé API et utilise le mode OAuth (même flow que
Claude CLI / Codex CLI) :

```
Broker (Deploy)                           Machine locale (tunnel)
     │                                          │
     │  Besoin d'auth pour Anthropic            │
     │  → génère un device code / URL OAuth     │
     │                                          │
     ├──── tunnel : auth_request {url, code} ──►│
     │                                    ouvre navigateur
     │                                    user se connecte
     │◄──── tunnel : token OAuth ───────────────┤
     │                                          │
     │  Stocke le token (KV / Secret Manager)   │
     │  fetch() avec token OAuth désormais      │
```

C'est un **one-shot** — le Broker stocke le token et l'utilise directement pour
les `fetch()` suivants. Pas de `Deno.Command`, pas de CLI exécuté — juste le
même flow d'auth que les CLIs utilisent.

## Flux — Communication inter-agents (A2A)

```
Agent A (Subhosting)             Broker (Deploy)              Agent B (Subhosting)
     │                                │                          │
     │  POST /agent { to:"b", ... }   │                          │
     ├──── HTTP (OIDC) ─────────────►│                          │
     │                                │  vérifie permissions     │
     │                                ├──── HTTP POST ──────────►│
     │                                │                          │ traite
     │                                │◄──── HTTP response ──────┤
     │◄── HTTP response ──────────────┤  { from:"agent-b", ... } │
```

## Le tunnel est un primitif, pas un add-on

Le tunnel WebSocket est le **mesh réseau** de DenoClaw — il connecte tout ce qui
n'est pas sur la même instance Deploy. Comme Tailscale crée un réseau privé
entre machines.

**Trois types de connexion tunnel :**

| Type                | Relie                    | Usage                                                   |
| ------------------- | ------------------------ | ------------------------------------------------------- |
| **Noeud → Broker**  | Machine/VPS/GPU → Broker | Outils distants (shell, FS, GPU), auth navigateur OAuth |
| **Broker → Broker** | Instance A ↔ Instance B  | Fédération A2A cross-instance, routage inter-agents     |
| **Local → Broker**  | Dev machine → Broker     | Outils locaux, auth flow, tests                         |

Les **agents** ne sont jamais directement sur le tunnel — ils passent par leur
Broker via HTTP. Le tunnel connecte les **composants d'infrastructure** entre
eux.

```
Instance A                    Instance B                    Machine locale
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Broker A │◄═══ tunnel ════►│ Broker B │                 │ denoclaw │
│  agents  │                 │  agents  │                 │ tunnel   │
└──────────┘                 └──────────┘                 └────┬─────┘
                                                               │
                              VPS (noeud)                      │
                             ┌──────────┐                      │
                             │GPU       │◄══ tunnel ═══════════╝
                             │Shell/FS  │
                             └──────────┘
```

Chaque tunnel déclare ses capabilities :

```typescript
// Noeud VPS avec outils
{
  type: "local",
  tools: ["shell", "fs_read", "fs_write"],
  allowedAgents: ["planner", "operator"],
}

// Broker B (inter-instance)
{
  type: "instance",
  agents: ["support", "billing"],  // agents routables via ce tunnel
}

// Dev machine locale
{
  type: "local",
  tools: ["shell", "fs_read", "fs_write"],
  allowedAgents: ["planner", "operator"],
}
```

## Justification

- **Zero secret dans les agents et Sandboxes** — les clés API et tokens OAuth
  restent sur le Broker
- **Interface uniforme pour l'agent** — `broker.complete({ messages, model })`
  quel que soit le mode d'auth (clé API ou OAuth)
- **Tracking de coûts** centralisé par agent / par utilisateur
- **Rate limiting** centralisé
- **Fallback chains** — provider A down → fallback sur provider B
- **Cache** et **logs centralisés**
- **Inter-agents** — le même broker qui route les LLM requests route aussi les
  messages entre agents

## Conséquences

- Le broker est un single point of failure → mitigation : Deploy multi-région
- Le broker doit maintenir un registre des tunnels actifs et de leurs
  capabilities
- Le broker stocke les tokens OAuth en KV (ou Secret Manager) — rotation
  automatique possible
- Les agents ont une interface unique : `broker.complete()` pour le LLM,
  `broker.toolExec()` pour les outils, `broker.submitTask()` /
  `broker.sendTextTask()` pour l'inter-agents
