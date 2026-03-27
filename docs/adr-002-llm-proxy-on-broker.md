# ADR-002 : LLM Proxy centralisé sur le Broker — API + CLI via tunnels

**Statut :** Accepté
**Date :** 2026-03-26

## Contexte

Les agents tournent en Subhosting (ADR-001). Ils appellent le Broker par HTTP pour tout : LLM, tools, A2A. Les Sandboxes (code execution) n'ont accès à aucun secret. Les LLM nécessitent une authentification — que ce soit des clés API (Anthropic, OpenAI) ou des sessions CLI sur des machines distantes (Codex CLI, Claude CLI).

Les agents ne se parlent jamais directement (pas d'URL publique). Tout passe par le Broker. Le tunnel est un primitif central pour connecter des machines/VPS comme noeuds au réseau — à la manière de Tailscale.

## Décision

**Le Broker (Deno Deploy) est le routeur central pour TOUT ce qui sort d'un agent** : calls LLM, exécution d'outils, et communication inter-agents. Le tunnel WebSocket est un primitif de premier ordre.

### Deux modes de LLM completion

**Mode API** — pour les providers HTTP (Anthropic, OpenAI, DeepSeek, etc.)
- Le broker détient les clés API (env vars chiffrées Deploy)
- L'agent demande une completion, le broker fait le fetch()

**Mode CLI via tunnel** — pour les providers CLI (Codex CLI, Claude CLI)
- Le broker route la requête vers un tunnel WebSocket
- La machine locale exécute le CLI (qui gère sa propre auth)
- Le résultat remonte par le tunnel

## Flux — Mode API

```
Agent (Subhosting)               Broker (Deploy)              API LLM
     │                                │                          │
     │  POST /llm { messages, model } │                          │
     ├──── HTTP (OIDC auth) ─────────►│                          │
     │                                │  + injecte la clé API    │
     │                                ├─── fetch() ─────────────►│
     │                                │◄── response ─────────────┤
     │◄── HTTP response ──────────────┤                          │
     │  { content, toolCalls }        │                          │
```

## Flux — Mode CLI (VPS connecté par tunnel)

Les CLIs (Claude, Codex) sont installés sur des **machines/VPS connectées par tunnel** au Broker — comme des noeuds Tailscale. Ce ne sont pas des agents, ce sont des **ressources** avec des capabilities (CLI, GPU, filesystem).

```
Agent (Subhosting)     Broker (Deploy)     Tunnel (WS)     VPS / Machine
     │                      │                   │                │
     │  POST /llm           │                   │                │
     │  model: "claude-cli" │                   │                │
     ├─── HTTP ────────────►│                   │                │
     │                      │  route vers VPS   │                │
     │                      ├──── WS ──────────►├───────────────►│
     │                      │                   │  Deno.Command  │
     │                      │                   │  "claude"      │
     │                      │                   │◄───────────────┤
     │                      │◄──── WS ──────────┤                │
     │◄── HTTP response ────┤                   │                │
```

L'agent ne sait pas si c'est Mode API ou Mode CLI — interface uniforme `broker.complete()`.

**Auth initiale CLI** : quand le CLI a besoin d'auth navigateur (OAuth/device code), le tunnel route l'URL d'auth vers la machine locale de l'utilisateur :

```
VPS (CLI)                    Broker (Deploy)              Machine locale (tunnel)
     │                            │                          │
     │  auth_request {url, code}  │                          │
     ├──── tunnel ───────────────►├──── tunnel ─────────────►│
     │                            │                   ouvre navigateur
     │                            │                   user se connecte
     │                            │◄──── token ──────────────┤
     │◄──── token ────────────────┤                          │
     │                            │                          │
     │  CLI authentifié, autonome │                          │
```

C'est un **one-shot** — le CLI stocke son token sur le VPS et n'a plus besoin du tunnel.

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

Le tunnel WebSocket est le **mesh réseau** de DenoClaw — il connecte tout ce qui n'est pas sur la même instance Deploy. Comme Tailscale crée un réseau privé entre machines.

**Trois types de connexion tunnel :**

| Type | Relie | Usage |
|---|---|---|
| **Noeud → Broker** | Machine/VPS/GPU → Broker | Outils distants (CLI, shell, FS, GPU), auth navigateur |
| **Broker → Broker** | Instance A ↔ Instance B | Fédération A2A cross-instance, routage inter-agents |
| **Local → Broker** | Dev machine → Broker | Outils locaux, auth flow, tests |

Les **agents** ne sont jamais directement sur le tunnel — ils passent par leur Broker via HTTP. Le tunnel connecte les **composants d'infrastructure** entre eux.

```
Instance A                    Instance B                    Machine locale
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Broker A │◄═══ tunnel ════►│ Broker B │                 │ denoclaw │
│  agents  │                 │  agents  │                 │ tunnel   │
└──────────┘                 └──────────┘                 └────┬─────┘
                                                               │
                              VPS (noeud)                      │
                             ┌──────────┐                      │
                             │Claude CLI│◄══ tunnel ═══════════╝
                             │GPU       │
                             └──────────┘
```

Chaque tunnel déclare ses capabilities :

```typescript
// Noeud VPS avec CLIs
{
  type: "node",
  tools: ["shell", "fs_read", "fs_write"],
  providers: ["claude-cli", "codex-cli"],
  supportsAuth: true,
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
  supportsAuth: true,
}
```

## Justification

- **Zero secret dans les agents et Sandboxes** — les clés API restent sur le broker, les tokens CLI restent sur les noeuds VPS
- **Interface uniforme pour l'agent** — `broker.complete({ messages, model })` quel que soit le backend (API, CLI via tunnel, etc.)
- **Tracking de coûts** centralisé par agent / par utilisateur
- **Rate limiting** centralisé
- **Fallback chains** — model "codex-cli" down → fallback sur "openai/gpt-4o" en API
- **Cache** et **logs centralisés**
- **Inter-agents** — le même broker qui route les LLM requests route aussi les messages entre agents

## Conséquences

- Le broker est un single point of failure → mitigation : Deploy multi-région
- Latence CLI : +1 hop réseau (agent → broker → tunnel → CLI → retour) → acceptable vs le temps de génération LLM
- Le broker doit maintenir un registre des tunnels actifs et de leurs capabilities
- Si un tunnel tombe, le broker peut fallback sur un provider API
- Les agents ont une interface unique : `broker.complete()` pour le LLM, `broker.toolExec()` pour les outils, `broker.sendToAgent()` pour l'inter-agents
