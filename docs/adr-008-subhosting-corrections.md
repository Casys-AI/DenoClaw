# ADR-008 : Corrections architecture Subhosting — Broker orchestre, agents réactifs

**Statut :** Accepté **Date :** 2026-03-27

## Contexte

L'audit de la doc officielle Deno Subhosting a révélé des erreurs fondamentales
dans notre modèle d'exécution. L'architecture actuelle assume que les agents
Subhosting sont des daemons long-running avec `Deno.cron()` et
`kv.listenQueue()`. En réalité, ces deux APIs ne fonctionnent pas en Subhosting.

### Claims vérifiées (sources officielles)

| Claim                              | Verdict  | Source                                                                                        |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `Deno.cron()` bloqué en Subhosting | CONFIRMÉ | docs.deno.com/subhosting/api/ — _"Deno Cron and Queues do not currently work for Subhosting"_ |
| `kv.listenQueue()` bloqué          | CONFIRMÉ | Même phrase, même doc                                                                         |
| Isolates pas long-running          | CONFIRMÉ | Idle timeout 5 sec à 10 min, SIGKILL après                                                    |
| KV pas auto-isolé par deployment   | CONFIRMÉ | KV databases créées et bindées explicitement via API                                          |
| API v1 sunset 20 juillet 2026      | CONFIRMÉ | Multiple sources officielles                                                                  |
| Workers dans Subhosting            | INCONNU  | Pas documenté, ne résout pas la persistence                                                   |

### Changements API v2

|              | v1                         | v2                                           |
| ------------ | -------------------------- | -------------------------------------------- |
| Terminologie | Projects / Deployments     | **Apps / Revisions**                         |
| Champs       | camelCase                  | **snake_case**                               |
| Entry point  | `entryPointUrl`            | `config.runtime.entrypoint`                  |
| Env vars     | object                     | array                                        |
| Status       | `pending`/`success`        | `queued`/`succeeded`                         |
| RAM max      | 512 MB                     | **4 GB**                                     |
| CPU limits   | Per-request (50-200ms avg) | **Pas de limite par requête**                |
| Nouveautés   | —                          | Labels, Layers, SSE logs, custom build steps |

## Code impacté

### Critique (cassé en Subhosting)

| Fichier                       | Problème                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/agent/runtime.ts`        | `Deno.cron()` via CronManager + `kv.listenQueue()`. Modèle daemon `start()`/`stop()`.                            |
| `src/orchestration/client.ts` | Communication par `kv.enqueue()`/`kv.listenQueue()` + `pendingRequests` qui assume process persistant.           |
| `src/cli/setup.ts`            | Entrypoint généré contient `Deno.cron()`, `listenQueue()`, `Deno.serve()` keep-alive bidon. Cycle LLM incomplet. |

### Haut (pas aligné avec l'archi)

| Fichier                        | Problème                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `main.ts`                      | `AgentLoop` tourne in-process, pas de `new Worker()`.    |
| `src/orchestration/gateway.ts` | `AgentLoop` dans les handlers HTTP, bloque l'event loop. |
| `src/cli/setup.ts`             | API Subhosting v1 (`api.deno.com/v1`).                   |
| `src/orchestration/sandbox.ts` | API Sandbox v1.                                          |

### Couverture tests

Zéro tests sur AgentRuntime, BrokerClient, CronManager, entrypoint généré.

## Décision

### Principe

> **Le Broker orchestre. L'agent réagit. Le code s'exécute en Sandbox.**

En Subhosting, l'agent est un serveur HTTP pur. Il reçoit du travail par POST,
fait ses calculs (y compris LLM multi-step), et soit retourne un résultat
synchrone (tâche rapide), soit retourne un taskId + stream SSE (tâche longue).
Le Broker est le message store durable et le cron dispatcher.

> **A2A over transport X, persisted in KV, correlated by task/context ids.**

### Trois couches — Deploy et Local

| Rôle           | Deploy                              | Local                           |
| -------------- | ----------------------------------- | ------------------------------- |
| Orchestrateur  | Broker (Deno Deploy)                | **Process** (main)              |
| Agent          | Subhosting (warm-cached V8 isolate) | **Worker** (`new Worker()`)     |
| Exécution code | Sandbox (microVM)                   | **Subprocess** (`Deno.Command`) |

Multi-agent est le mode par défaut, même en dev. Chaque agent a un nom — pas de
"default".

### Communication — 3 couches

| Couche               | Rôle                                      | Local                              | Deploy                                     |
| -------------------- | ----------------------------------------- | ---------------------------------- | ------------------------------------------ |
| **HTTP POST**        | Transport de travail A2A au réveil        | Pas nécessaire (Workers always-on) | Seul moyen de wake Subhosting              |
| **WebSocket**        | Communication continue / optimisation     | `postMessage` (≈ WS local)         | WS persistant tant que l'agent est éveillé |
| **BroadcastChannel** | Infra seulement (shutdown, config reload) | ✅ entre Workers                   | N/A (ne marche pas cross-deployment)       |

En d'autres termes : **A2A over transport X, persisted in KV, correlated by task/context ids.**

Flux deploy : HTTP POST réveille l'agent → agent ouvre WS vers Broker →
communication bidirectionnelle → agent idle → WS meurt → retour à HTTP POST.

L'agent voit une seule interface (`AgentBrokerPort`). Le dual mode est dans
l'infra, pas dans le code agent.

### Routing — le Broker est le routeur universel

Toute communication agent ↔ agent passe par le Broker. L'agent ne sait pas où
est la cible.

| L'agent veut parler à...     | Le Broker fait...                         |
| ---------------------------- | ----------------------------------------- |
| Un agent même instance       | postMessage (local) ou WS (deploy)        |
| Un agent autre instance      | Tunnel → Broker distant → WS vers l'agent |
| Plusieurs agents (multicast) | Fan-out, même logique par agent cible     |

BroadcastChannel n'est PAS utilisé pour la communication inter-agents —
seulement pour l'infra (shutdown, config reload).

### KV — store vs transport

**KV comme store = oui partout. KV comme transport (enqueue/listenQueue) =
local + Broker Deploy uniquement.**

Deux KV par agent :

- **KV privé** (`./data/<agentId>.db` local, DB bindée en deploy) — mémoire,
  sessions, historique A2A propre
- **KV partagé** (`./data/shared.db` local, DB bindée à tous en deploy) —
  messages inter-agents, traces, routing, cron schedules

En local, KV Queues fonctionnent entre Workers (même SQLite). En deploy, le
Broker utilise KV Queues en interne et pousse vers les agents par HTTP.

### Communication Deploy

```
Deploy ↔ Subhosting = HTTP direct (même plateforme Deno, pas de tunnel)
Agent → Broker     : fetch() HTTP avec OIDC auth
Broker → Agent     : HTTP POST (messages, cron triggers, tâches A2A)
Durabilité         : KV Queues interne Broker (Deploy)
```

### Tâches longues — pattern A2A task + SSE

```
1. Broker POST /tasks → Agent
2. Agent retourne 202 Accepted { taskId }
3. Agent exécute le ReAct loop (LLM calls via fetch au Broker)
4. Agent écrit le progrès en KV + stream SSE sur GET /tasks/{id}/events
5. Broker subscribe au SSE, re-émet au caller, stocke le résultat final
```

Les types A2A existants dans `src/messaging/a2a/types.ts` sont le wire format
(TaskState, TaskStatusUpdateEvent).

### Cron — dispatcher unique

`Deno.cron()` est extrait statiquement de l'AST sur Deploy. Un seul cron
dispatcher lit les schedules agents depuis KV et dispatche par HTTP POST.

### Auth Agent → Broker — OIDC préféré

`@deno/oidc` (probablement disponible en Subhosting, même infra que Deploy). Le
Broker vérifie `org_id` + `app_id` dans le JWT. Fallback : Layers (v2) / invite
token. Pas d'auth en local (postMessage interne).

### LLM — Clé API + OAuth, pas de CLI

Le Broker fait `fetch()` avec une clé API ou un token OAuth (même flow que
Claude CLI / Codex CLI, juste l'auth). Pas de `Deno.Command`. Le tunnel sert
uniquement pour l'auth initiale OAuth (ouvrir le navigateur).

### Traces — via le Broker

Les traces agent remontent au Broker via HTTP. Le Broker les écrit dans le KV
partagé. Le dashboard `kv.watch()` le KV Broker.

### Tunnels — mesh hors plateforme

Les tunnels connectent ce qui est **hors** de la plateforme Deno : machines
locales (outils, auth), VPS/GPU (ressources), autres Brokers (fédération).
Deploy ↔ Subhosting n'a pas besoin de tunnel.

## Conséquences

- L'architecture passe de "agent orchestre, Broker route" à **"Broker orchestre,
  agent réagit"**
- Le code agent est identique en local (Worker) et en deploy (Subhosting)
- La durabilité est centralisée dans le Broker (seul composant avec KV Queues en
  deploy)
- Les types A2A existants deviennent le wire format natif agent ↔ Broker
- Le modèle 3 couches (Process/Worker/Subprocess ↔ Broker/Subhosting/Sandbox)
  est cohérent
