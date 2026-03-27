# ADR-008 : Corrections architecture Subhosting

**Statut :** Proposition (a challenger)
**Date :** 2026-03-27

## Contexte

L'audit de la doc officielle Deno Subhosting a révélé des erreurs fondamentales dans notre modèle d'exécution. L'architecture actuelle assume que les agents Subhosting sont des daemons long-running avec `Deno.cron()` et `kv.listenQueue()`. En réalité, ces deux APIs ne fonctionnent pas en Subhosting.

### Claims vérifiées (sources officielles)

| Claim | Verdict | Source |
|---|---|---|
| `Deno.cron()` bloqué en Subhosting | CONFIRMÉ | docs.deno.com/subhosting/api/ — *"Deno Cron and Queues do not currently work for Subhosting"* |
| `kv.listenQueue()` bloqué | CONFIRMÉ | Même phrase, même doc |
| Isolates pas long-running | CONFIRMÉ | Idle timeout 5 sec à 10 min, SIGKILL après |
| KV pas auto-isolé par deployment | CONFIRMÉ | KV databases créées et bindées explicitement via API |
| API v1 sunset 20 juillet 2026 | CONFIRMÉ | Multiple sources officielles |
| Workers dans Subhosting | INCONNU | Pas documenté, ne résout pas la persistence |

### Changements API v2

| | v1 | v2 |
|---|---|---|
| Terminologie | Projects / Deployments | **Apps / Revisions** |
| Champs | camelCase | **snake_case** |
| Entry point | `entryPointUrl` | `config.runtime.entrypoint` |
| Env vars | object | array |
| Status | `pending`/`success` | `queued`/`succeeded` |
| RAM max | 512 MB | **4 GB** |
| CPU limits | Per-request (50-200ms avg) | **Pas de limite par requête** |
| Nouveautés | — | Labels, Layers, SSE logs, custom build steps |

## Code impacté — audit

### Critique (cassé en Subhosting)

| Fichier | Lignes | Problème |
|---|---|---|
| `src/subhosting/agent_runtime.ts` | 6, 28, 37, 57-78 | `Deno.cron()` via CronManager + `kv.listenQueue()`. Tout le modèle `start()`/`stop()` assume un daemon. |
| `src/broker/client.ts` | 42-58, 95 | Communication par `kv.enqueue()`/`kv.listenQueue()` + map `pendingRequests` qui assume process persistant. |
| `src/cli/setup.ts` | 326, 342, 358, 366 | Entrypoint généré contient `Deno.cron()`, `listenQueue()`, `Deno.serve()` keep-alive bidon. Le cycle LLM request/response est incomplet (pas de corrélation `pendingRequests`). |

### Haut (pas aligné avec l'archi)

| Fichier | Lignes | Problème |
|---|---|---|
| `main.ts` | 41, 58-60 | `AgentLoop` tourne in-process, pas de `new Worker()`. |
| `src/gateway/mod.ts` | 89, 166, 204 | `AgentLoop` dans les handlers HTTP, bloque l'event loop. 3 endroits. |
| `src/cli/setup.ts` | 220 | API Subhosting v1 (`api.deno.com/v1`). |
| `src/sandbox/mod.ts` | 48 | API Sandbox v1 (`api.deno.com/v1/sandbox`). |

### Race condition existante

`AgentRuntime` (ligne 57) et `BrokerClient` (ligne 47) appellent `kv.listenQueue()` sur le même KV. Chaque message est livré aux deux handlers. Guards informels par `msg.type` — race condition latente.

### Couverture tests

Zéro tests sur `AgentRuntime`, `BrokerClient`, `CronManager`, entrypoint généré. Aucun filet de sécurité pour le refactoring.

## Décision — nouveau modèle

### Principe

> **En Subhosting, l'agent est un serveur HTTP pur.** Il reçoit du travail par POST, fait ses calculs (y compris LLM multi-step), et soit retourne un résultat synchrone (tâche rapide), soit retourne un taskId + stream SSE (tâche longue). Le Broker est le message store durable et le cron dispatcher. Le KV de l'agent sert uniquement à son état interne (mémoire, sessions), jamais à la communication inter-process.

### Trois couches — Deploy et Local

| Rôle | Deploy | Local |
|---|---|---|
| Orchestrateur | Broker (Deno Deploy) | **Process** (main) |
| Agent | Subhosting (warm-cached V8 isolate) | **Worker** (`new Worker()`) |
| Exécution code | Sandbox (microVM) | **Subprocess** (`Deno.Command`) |
| Transport orchestrateur → agent | HTTP POST | `postMessage` |
| Transport agent → sandbox | API Sandbox (HTTP) | `Deno.Command` (spawn) |

Multi-agent est le mode par défaut, même en dev. Workers obligatoires.

### Communication

```
Agent → Broker : fetch() HTTP (requêtes LLM, tools, A2A)
Broker → Agent : HTTP POST (messages, cron triggers, tâches A2A)
Durabilité      : KV du Broker (Deploy, où listenQueue fonctionne)
```

L'agent ne poll jamais. Le Broker pousse le travail par HTTP.

### KV — store vs transport

**KV comme store = oui partout. KV comme transport (enqueue/listenQueue) = non en Subhosting.**

| Donnée | KV Agent (par agent) | KV Broker (central) |
|---|---|---|
| Mémoire / sessions | oui | non |
| Config agent, skills | oui | non |
| Logs A2A (tasks reçues/envoyées) | oui (les siennes) | oui (toutes — observabilité) |
| Résultats de tâches | oui (les siens) | oui (dashboard, `kv.watch()`) |
| Cron schedules | non | oui |
| Message routing / queues | non | oui (listenQueue fonctionne sur Deploy) |
| Metrics / telemetry | non | oui |

Le KV agent sert à son état interne **et à l'historique de ses tâches A2A**. Le KV Broker centralise tout le trafic pour l'observabilité (dashboard via `kv.watch()`). Pas de KV queue entre les deux — HTTP uniquement.

### Tâches longues — pattern A2A task + SSE

Un HTTP synchrone ne tient pas pour un ReAct loop de 2-3 minutes. Le pattern :

```
1. Broker POST /tasks → Agent
2. Agent retourne 202 Accepted { taskId }
3. Agent exécute le ReAct loop (LLM calls via fetch au Broker)
4. Agent écrit le progrès en KV + stream SSE sur GET /tasks/{id}/events
5. Broker subscribe au SSE, re-émet au caller, stocke le résultat final
```

Les types A2A existants dans `src/a2a/types.ts` sont le wire format :
- `TaskState` : SUBMITTED → WORKING → INPUT_REQUIRED → COMPLETED
- `TaskStatusUpdateEvent` : pour le stream SSE

### Cron — dispatcher unique

`Deno.cron()` est extrait statiquement de l'AST sur Deploy — on ne peut pas l'appeler dynamiquement en boucle par agent.

Solution :

```typescript
// Un seul cron sur le Broker (statique, extrait par Deploy)
Deno.cron("agent-cron-dispatcher", "* * * * *", async () => {
  const kv = await Deno.openKv();
  // Lire les schedules agents depuis KV
  for await (const entry of kv.list<CronSchedule>({ prefix: ["cron_schedules"] })) {
    if (isDue(entry.value)) {
      await fetch(`https://${entry.value.agentUrl}/cron/${entry.value.job}`, { method: "POST" });
    }
  }
});
```

L'agent déclare ses crons dans sa config. Le Broker les persiste en KV. Le dispatcher les évalue chaque minute.

## Chantiers d'implémentation

### Chantier 1 — AgentRuntime → HTTP handler + A2A tasks

- Supprimer `start()`/`stop()` (modèle daemon)
- Supprimer import `CronManager`
- Supprimer `kv.listenQueue()`
- Nouveau point d'entrée : `Deno.serve()` avec routes HTTP
- Handler synchrone pour tâches rapides, A2A task + SSE pour tâches longues
- KV uniquement pour état interne (mémoire, sessions)

### Chantier 2 — BrokerClient → HTTP client

- Supprimer `kv.enqueue()` / `kv.listenQueue()` / `pendingRequests`
- Remplacer par `fetch()` vers les endpoints HTTP du Broker
- Ajouter `brokerUrl` au constructeur
- Le Broker ajoute des endpoints REST : `POST /llm`, `POST /tool`, `POST /agent`
- `BrokerServer` garde son KV Queue côté Deploy (ça fonctionne) pour la durabilité

### Chantier 3 — Workers en local

- `main.ts` : spawner `new Worker()` par agent au lieu de `AgentLoop` in-process
- `src/gateway/mod.ts` : pareil (3 endroits)
- Worker entrypoint : importe `AgentLoop`, écoute `onmessage`, répond par `postMessage`
- Bridge WebSocket : gateway reçoit `postMessage` du Worker, forwarde au WebSocket client
- OTEL : propagation de contexte explicite via `postMessage`

### Chantier 4 — Cron dispatcher

- Un seul `Deno.cron()` statique sur le Broker
- KV store `["cron_schedules", agentId, jobName]` → `{ schedule, agentUrl, enabled }`
- Évaluation cron expression en userspace (lib ou implem simple)
- HTTP POST vers l'agent quand le cron est dû
- `CronManager` reste pour le mode local (dans le main process)

### Chantier 5 — API v2

- `src/cli/setup.ts` : `api.deno.com/v1` → `api.deno.com/v2`
- `src/sandbox/mod.ts` : pareil
- Adapter les noms : Projects → Apps, Deployments → Revisions
- camelCase → snake_case dans les payloads
- Générer le nouvel entrypoint avec `Deno.serve()` HTTP handler

### Chantier 6 — Entrypoint généré

- Réécrire `generateAgentEntrypoint()` dans `src/cli/setup.ts`
- Plus de `Deno.cron()`, `listenQueue()`, ou `Deno.serve()` keep-alive bidon
- Générer un vrai HTTP handler avec routes : `/tasks`, `/cron/:job`, `/health`
- Préserver les writes KV de config (nécessaires pour permissions intersection ADR-005)

### Chantier 7 — Tests

- Écrire des tests pour `AgentRuntime`, `BrokerClient`, `CronManager` AVANT de refactorer
- Couvrir les cas : réception HTTP, cycle LLM, SSE streaming, cron trigger
- Mock `fetch` pour les appels Broker
- Aucun filet actuel → priorité haute

## Ordre suggéré

1. **Tests** (chantier 7) — filet de sécurité avant tout refactoring
2. **BrokerClient HTTP** (chantier 2) — fondation, utilisé par tout le reste
3. **AgentRuntime HTTP** (chantier 1) — dépend du nouveau BrokerClient
4. **Workers** (chantier 3) — mode local multi-agent
5. **Cron dispatcher** (chantier 4) — dépend du Broker HTTP
6. **Entrypoint** (chantier 6) — dépend des chantiers 1-2
7. **API v2** (chantier 5) — indépendant, peut se faire en parallèle

## Risques

| Risque | Impact | Mitigation |
|---|---|---|
| Semver-breaking sur `mod.ts` exports | SDK consumers cassés | Documenter les breaking changes, version bump |
| SSE timeout en Subhosting (idle 5s-10min) | Stream coupé pendant tâche longue | Keep-alive frames, retry côté Broker |
| `Deno.cron()` statique — si Deploy change le modèle | Dispatcher devient inutile | Abstraction : `CronScheduler` interface, implem KV-based |
| Migration v2 non triviale (noms, casing) | Régression setup/publish | Tests d'intégration sur le flow publish |
| OTEL spans ne traversent pas les Workers | Telemetry cassée silencieusement | Propagation contexte explicite via postMessage |

## Conséquences

- L'architecture passe de "agent orchestre, Broker route" à **"Broker orchestre, agent réagit"**
- Le code agent est identique en local (Worker) et en deploy (Subhosting) — même HTTP handler
- La durabilité est centralisée dans le Broker (seul composant avec KV Queues fonctionnelles)
- Les types A2A existants deviennent le wire format natif agent ↔ Broker
- Le modèle 3 couches (Process/Worker/Subprocess ↔ Broker/Subhosting/Sandbox) est explicite et cohérent
