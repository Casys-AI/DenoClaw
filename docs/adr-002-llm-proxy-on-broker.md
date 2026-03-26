# ADR-002 : LLM Proxy centralisé sur le Broker — API + CLI via tunnels

**Statut :** Accepté
**Date :** 2026-03-26

## Contexte

Les agents tournent en Sandbox (ADR-001). Les Sandboxes n'ont accès à aucun secret. Or les LLM nécessitent une authentification — que ce soit des clés API (Anthropic, OpenAI) ou des sessions CLI locales (Codex CLI, Claude CLI).

De plus, les agents Sandbox doivent pouvoir communiquer entre eux, mais ne peuvent pas se parler directement (network isolation). Le tunnel est donc un primitif central, pas un add-on.

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
Agent (Sandbox)                  Broker (Deploy)              API LLM
     │                                │                          │
     │  { messages, model }           │                          │
     ├──── KV Queue ─────────────────►│                          │
     │                                │  + injecte la clé API    │
     │                                ├─── fetch() ─────────────►│
     │                                │◄── response ─────────────┤
     │◄── KV Queue ───────────────────┤                          │
     │  { content, toolCalls }        │                          │
```

## Flux — Mode CLI (tourne sur le VPS de l'agent)

Les CLIs (Claude, Codex) sont installés **sur le VPS/machine de l'agent**, pas en local. Ils sont appelés directement par l'agent via `Deno.Command`. Pas de tunnel pour les requêtes LLM.

```
Agent (VPS)                                         API LLM
     │                                                 │
     │  Deno.Command("claude", ["--print", prompt])    │
     │  (CLI authentifié localement sur le VPS)         │
     │  ────────────────────────────────────────────►   │
     │  ◄────────────────────────────────────────────   │
     │  response                                        │
```

**Auth initiale** : quand le CLI a besoin d'auth navigateur (OAuth/device code), le tunnel route l'URL d'auth vers la machine locale de l'utilisateur :

```
VPS (CLI)                    Broker (Deploy)              Machine locale
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

## Flux — Communication inter-agents

```
Agent A (Sandbox)                Broker (Deploy)              Agent B (Sandbox)
     │                                │                          │
     │  { to:"agent-b", payload }     │                          │
     ├──── KV Queue ─────────────────►│                          │
     │                                │  vérifie permissions     │
     │                                ├──── KV Queue ───────────►│
     │                                │                          │
     │                                │◄──── KV Queue ───────────┤
     │◄── KV Queue ───────────────────┤  { from:"agent-b", ... } │
```

## Le tunnel est un primitif, pas un add-on

Le tunnel WebSocket sert à :
1. **Outils locaux** — exécuter shell, filesystem, scripts sur la machine locale de l'utilisateur
2. **Auth flow navigateur** — quand un CLI sur un VPS a besoin d'auth OAuth/device code, le tunnel route l'URL vers la machine locale qui ouvre le navigateur (one-shot, puis le CLI est autonome)
3. **Communication inter-agents** — connecter des machines distantes au broker

Les CLIs (Claude, Codex) tournent **sur le VPS de l'agent**, pas en local. Le tunnel ne route pas les requêtes LLM — seulement l'auth initiale et les outils.

```typescript
// Tunnel = outils locaux + réception des auth requests
{
  tools: ["shell", "fs_read", "fs_write"],
  supportsAuth: true,
}
```

## Justification

- **Zero secret dans les Sandboxes** — les clés API restent sur le broker, les tokens CLI restent sur le VPS de l'agent
- **Interface uniforme pour l'agent** — `broker.complete({ messages, model })` pour les API, `Deno.Command` pour les CLI locaux au VPS
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
