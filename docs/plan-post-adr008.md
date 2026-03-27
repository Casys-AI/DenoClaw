# Plan d'implémentation — Post ADR-008

**Date :** 2026-03-27

## Phase 1 — Workers multi-agent local (prioritaire)

### DoD

**Fonctionnel :**
- [ ] `deno task start agent -- -m "hello"` spawne un Worker, exécute, retourne le résultat
- [ ] Config multi-agent → N Workers spawnés (un par agent déclaré)
- [ ] Messages routés du main process au bon Worker
- [ ] Réponses remontent du Worker au main process
- [ ] Gateway route les requêtes HTTP/WS vers les Workers
- [ ] Chaque Worker a son KV privé (`./data/<agentId>.db`) + accès au KV partagé (`./data/shared.db`)
- [ ] Crash Worker ne crash pas le main process
- [ ] Shutdown propre : BroadcastChannel `shutdown` → Workers terminent

**Architecture :**
- [ ] `src/agent/worker_entrypoint.ts` — point d'entrée Worker, wrapper autour d'AgentLoop
- [ ] Communication main ↔ Worker par `postMessage`
- [ ] Le Worker ne fait aucun import depuis `src/orchestration/`
- [ ] AgentLoop existant reste inchangé

**Qualité :**
- [ ] `deno task test` passe
- [ ] `deno task check` passe
- [ ] `deno task lint` passe
- [ ] Test : spawn Worker + envoi message + réception réponse
- [ ] Test : shutdown propre

## Phase 2 — Deploy Subhosting

### Chantier 2.1 — BrokerClient mode HTTP

- Ajouter `fetch()` vers endpoints Broker (mode deploy)
- Garder KV Queue mode (local)
- Interface commune, deux implémentations
- Endpoints Broker : `POST /llm`, `POST /tool`, `POST /agent`

### Chantier 2.2 — AgentRuntime HTTP

- `Deno.serve()` réactif pour Subhosting
- Tâches rapides : sync dans la HTTP response
- Tâches longues : 202 Accepted + SSE (pattern A2A task)
- Supprimer modèle daemon (`start()`/`stop()`, `listenQueue`, `CronManager`)

### Chantier 2.3 — Auth OIDC agent → Broker

- `@deno/oidc` préféré, vérifier runtime avec `supportsIssuingIdTokens`
- Broker vérifie `org_id` + `app_id` dans le JWT
- Fallback : Layers (v2) / invite token

### Chantier 2.4 — Cron dispatcher

- Un seul `Deno.cron()` statique sur le Broker
- KV store `["cron_schedules", agentId, jobName]`
- Évaluation cron expression en userspace
- HTTP POST vers agent quand dû
- `CronManager` reste pour le mode local

### Chantier 2.5 — API v2

- `src/cli/setup.ts` + `src/orchestration/sandbox.ts` : v1 → v2
- Projects → Apps, Deployments → Revisions
- camelCase → snake_case
- Deadline : 20 juillet 2026

### Chantier 2.6 — Entrypoint Subhosting

- Réécrire `generateAgentEntrypoint()` dans `src/cli/setup.ts`
- `Deno.serve()` HTTP handler avec routes : `/tasks`, `/cron/:job`, `/health`
- Plus de `Deno.cron()`, `listenQueue()`, ou keep-alive bidon

### Chantier 2.7 — Tests

- Tests pour AgentRuntime, BrokerClient, CronManager
- Réception HTTP, cycle LLM, SSE streaming, cron trigger
- Mock `fetch` pour les appels Broker

## Décisions prises (hors scope implémentation immédiate)

Ces décisions ont été validées pendant la session et documentées dans les ADR. Elles ne sont pas à implémenter maintenant mais doivent être respectées quand on y touche.

| Sujet | Décision | Où c'est documenté |
|---|---|---|
| **KV Queues en local** | On les garde — elles marchent. On n'ajoute HTTP que pour Subhosting. | ADR-008 |
| **KV partagé + KV privé** | Chaque agent a un KV privé (mémoire) + accès au KV partagé (messages, traces, routing) | ADR-008 |
| **BroadcastChannel** | Pour les événements éphémères (config reload, shutdown). Pas pour le messaging durable. | Architecture-distributed |
| **OAuth LLM (pas CLI)** | Le "Mode CLI" = juste le flow OAuth. Pas de `Deno.Command`. **Basse priorité** — on utilise surtout l'API cloud Ollama pour les agents. | ADR-002 |
| **Tunnels = mesh hors plateforme** | Tunnels pour machines locales, VPS/GPU, fédération brokers. Pas entre Deploy et Subhosting (HTTP direct). | ADR-002, Architecture |
| **Traces via Broker** | Les traces agent remontent au Broker par HTTP. Dashboard watch le KV Broker, pas le KV agent. | ADR-007, ADR-008 |
| **Auth OIDC préféré** | OIDC partout sauf Sandbox (credentials materialization) et local (pas d'auth). Fallback Layers/invite. | ADR-003 |
| **Cron dispatcher statique** | Un seul `Deno.cron()` sur le Broker, lit les schedules KV. `Deno.cron()` est extrait statiquement par Deploy. | ADR-008 |
| **Browser agents** | Service externe (Browserbase, etc.) routé par le Broker comme un provider. Pas de Chromium dans l'archi. | A creuser |
| **Multi-agent = défaut** | Toujours multi-agent, même en dev. Workers obligatoires, pas optionnels. | CLAUDE.md, mémoire projet |
| **A2A task + SSE pour tâches longues** | 202 Accepted + taskId, SSE pour le progrès. Types A2A existants = wire format. | ADR-008 |
| **API Subhosting v2** | Obligatoire. Projects→Apps, Deployments→Revisions. Deadline 20 juillet 2026. | ADR-008, ADR-001 |

## Ordre suggéré

```
Phase 1: Workers local (débloque le multi-agent)
    ↓
Phase 2: 2.7 Tests → 2.1 BrokerClient HTTP → 2.2 AgentRuntime → 2.3 Auth OIDC
    ↓
Phase 2 (suite): 2.4 Cron → 2.6 Entrypoint → 2.5 API v2 (indépendant, en parallèle)
```

## Risques

| Risque | Impact | Mitigation |
|---|---|---|
| Semver-breaking sur `mod.ts` exports | SDK consumers cassés | Documenter les breaking changes, version bump |
| SSE timeout en Subhosting (idle 5s-10min) | Stream coupé pendant tâche longue | Keep-alive frames, retry côté Broker |
| `Deno.cron()` statique — si Deploy change le modèle | Dispatcher devient inutile | Abstraction : `CronScheduler` interface |
| Migration v2 non triviale (noms, casing) | Régression setup/publish | Tests d'intégration sur le flow publish |
| OTEL spans ne traversent pas les Workers | Telemetry cassée silencieusement | Propagation contexte explicite via postMessage |
| OIDC pas disponible en Subhosting | Auth fallback nécessaire | Guard `supportsIssuingIdTokens` + fallback Layers/invite |
