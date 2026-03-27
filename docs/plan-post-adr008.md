# Plan d'implémentation — Post ADR-008

**Date :** 2026-03-27

## Phase 1 — Workers multi-agent local ✅ DONE

- [x] WorkerPool spawn/routing/shutdown avec protocol typé
- [x] Worker entrypoint (init, process, shutdown via BroadcastChannel)
- [x] Chaque agent a un nom (`--agent` requis, pas de "default")
- [x] KV privé par agent (`./data/<agentId>.db`) via Memory kvPath
- [x] Gateway accepte `agentId` dans /chat et WebSocket
- [x] AgentError structured error type
- [x] Review + fixes (addEventListener, init timeout, ready check, Map drain)
- [x] Monitoring endpoints (/stats, /agents, /cron) + MetricsCollector DI
- [x] WorkerPoolCallbacks (onWorkerReady, onWorkerStopped)
- [x] Fresh handler slot dans GatewayDeps (dashboard futur)
- [x] Test end-to-end OK (Worker + Ollama Cloud)

## Phase 1.5 — A2A routing + KV partagé + observabilité ✅ DONE

- [x] SendToAgentTool — tool A2A avec callback injecté (transport-agnostic)
- [x] Protocol Worker étendu (agent_send, agent_deliver, agent_result,
      agent_response, task_started, task_completed, agent_task)
- [x] WorkerPool routing A2A avec peer check (peers/acceptFrom fermé par défaut)
- [x] Worker n'écrit plus dans le shared KV — émet des messages, main process
      écrit (deploy-compatible)
- [x] Types observabilité déplacés dans shared/ (AgentTaskEntry,
      AgentStatusEntry, etc.)
- [x] Gateway routes : /agents/tasks, /agents/:name/task,
      /.well-known/agent-card.json
- [x] KV watch SSE étendu avec agent_task events
- [x] Naming harmonisé : agent_tasks KV, agent_task_update sentinel,
      AGENT_TASK_FAILED
- [x] AgentCard URL alignée avec les vrais endpoints
- [x] SendToAgentTool préserve les erreurs structurées (DenoClawError
      passthrough)
- [x] SSE controller.close() + deno.json --unstable-cron
- [x] 83 tests, check, lint OK

## Phase 2 — Deploy Subhosting

### Chantier 2.1 — BrokerClient mode HTTP

- Ajouter `fetch()` vers endpoints Broker (mode deploy)
- Garder KV Queue mode (local)
- Interface commune (`AgentBrokerPort`), deux implémentations

### Chantier 2.2 — AgentRuntime HTTP

- `Deno.serve()` réactif pour Subhosting
- Tâches rapides : sync HTTP response
- Tâches longues : 202 Accepted + SSE (pattern A2A task)

### Chantier 2.3 — Auth OIDC agent → Broker

- `@deno/oidc` préféré
- Fallback : Layers (v2) / invite token

### Chantier 2.4 — Cron dispatcher

- Un seul `Deno.cron()` statique, KV schedule store

### Chantier 2.5 — API v2

- Deadline : 20 juillet 2026

### Chantier 2.6 — Entrypoint Subhosting

- `Deno.serve()` HTTP handler

### Chantier 2.7 — Tests

- AgentRuntime, BrokerClient, CronManager

## Design debt identifié (reviews)

| Issue                                                                      | Priorité | Ref          |
| -------------------------------------------------------------------------- | -------- | ------------ |
| WorkerPool fait trop — extraire PeerPolicy et PendingMap                   | Medium   | Arch review  |
| Gateway.handleHttp = 230 lignes non structurées — extraire routeur         | Medium   | Arch review  |
| Agent message naming — consider outbound/inbound pattern                   | Low      | Arch + Codex |
| Endpoints pas très RESTful                                                 | Low      | Codex naming |
| Telemetry KV keys still use `a2a` prefix (protocol dimension — acceptable) | Low      | Codex        |
| Dashboard islands ne passent pas le auth token                             | Medium   | Codex arch   |

## Décisions prises

| Sujet                                 | Décision                                                      |
| ------------------------------------- | ------------------------------------------------------------- |
| **KV Queues en local**                | On les garde. HTTP seulement pour Subhosting.                 |
| **Communication 3 couches**           | HTTP (wake) + WS (perf) + BC (infra only).                    |
| **Routing = Broker**                  | Toute comm agent↔agent via Broker (1:1 et multicast fan-out). |
| **Agent ne fait jamais kv.watch()**   | Seul le Broker watch. Agent fait read/write.                  |
| **Worker n'écrit pas dans shared KV** | Émet des messages, main process écrit. Deploy-compatible.     |
| **OAuth LLM**                         | Basse priorité. API cloud Ollama par défaut.                  |
| **Auth OIDC préféré**                 | OIDC partout sauf Sandbox et local.                           |
| **Multi-agent = défaut**              | Toujours multi-agent. `--agent` requis.                       |
| **API Subhosting v2**                 | Obligatoire. Deadline 20 juillet 2026.                        |
