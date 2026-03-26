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

## Flux — Mode CLI via tunnel

```
Agent (Sandbox)                  Broker (Deploy)              Machine locale
     │                                │                          │
     │  { messages, model:"codex-cli"}│                          │
     ├──── KV Queue ─────────────────►│                          │
     │                                │  route vers tunnel       │
     │                                ├──── WebSocket ──────────►│
     │                                │                          │ Deno.Command("codex", [...])
     │                                │                          │ (CLI gère sa propre auth)
     │                                │◄──── WebSocket ──────────┤
     │◄── KV Queue ───────────────────┤                          │
     │  { content, toolCalls }        │                          │
```

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
1. **Providers CLI** — Codex CLI, Claude CLI sur machine locale (gèrent leur propre auth)
2. **Outils locaux** — shell, filesystem, scripts sur machine locale ou VPS
3. **Communication inter-agents** — quand deux agents sont sur des machines différentes (hors Deploy), le tunnel permet de les connecter au broker

Chaque tunnel déclare ses **capabilities** :

```typescript
// Tunnel qui expose des providers CLI + des outils
{
  providers: ["codex-cli", "claude-cli"],       // LLM via CLI
  tools: ["shell", "fs_read", "fs_write"],      // outils locaux
}
```

Le broker sait quoi router où grâce à ces déclarations.

## Justification

- **Zero secret dans les Sandboxes** — les clés API restent sur le broker, les tokens CLI restent sur la machine locale
- **Interface uniforme pour l'agent** — `broker.complete({ messages, model })` que ce soit une API HTTP ou un CLI local, l'agent ne sait pas et n'a pas besoin de savoir
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
