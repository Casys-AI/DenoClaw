# Architecture distribuée DenoClaw

## Principe fondamental

**Le Broker orchestre. L'agent réagit. Le code s'exécute en Sandbox.**

**A2A over transport X, persisted in KV, correlated by task/context ids.**

Trois couches, chacune avec son rôle (ADR-001) :

- **Broker** (Deno Deploy) = orchestrateur central (LLM proxy, cron, message
  routing, agent lifecycle). Seul composant réellement long-running.
- **Subhosting** = l'agent (warm-cached V8 isolates, KV pour état/mémoire). Se
  réveille sur HTTP du Broker, se rendort quand idle. **Pas de `Deno.cron()`,
  pas de `listenQueue()`.**
- **Sandbox** = l'exécution (éphémère, permissions hardened, code
  skills/outils/LLM-generated)

Aucun code ne s'exécute directement dans le Subhosting. Tout passe par une
Sandbox avec des permissions verrouillées.

> **API Subhosting** : utiliser **v2** (`api.deno.com/v2`). La v1 est dépréciée
> (sunset juillet 2026).

## Vue d'ensemble

```
┌─────────────────── DENO DEPLOY (Broker) ───────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────┐       │
│  │              LLM Gateway / Proxy                 │       │
│  │  Mode Clé API : clés sur le broker → fetch()     │       │
│  │  Mode OAuth : token OAuth (flow navigateur)      │       │
│  │  Rate limiting, coûts, fallback, cache, logs     │       │
│  └──────────────────────┬──────────────────────────┘       │
│                         │                                   │
│  ┌──────────────────────┴──────────────────────────┐       │
│  │              Message Router                      │       │
│  │  HTTP POST → agents Subhosting                   │       │
│  │  KV Queues = durabilité interne Broker           │       │
│  │  KV Watch = observation temps réel               │       │
│  │  WebSocket hub = mesh tunnels                    │       │
│  └───┬──────────┬──────────┬──────────┬────────────┘       │
│      │          │          │          │                     │
│  ┌───┴──────┐  ┌──┴──────┐  ┌──┴──────┐  ┌──┴──────┐    │
│  │Subhost A  │  │Subhost B │  │Subhost C │  │Subhost D │   │
│  │Agent 1    │  │Agent 2   │  │Agent 3   │  │Agent 4   │   │
│  │KV propre  │  │KV propre │  │KV propre │  │KV propre │   │
│  │  ↓ exec   │  │  ↓ exec  │  │  ↓ exec  │  │  ↓ exec  │   │
│  │ Sandbox   │  │ Sandbox  │  │ Sandbox  │  │ Sandbox  │   │
│  │ (hardened)│  │(hardened)│  │(hardened)│  │(hardened)│   │
│  └──────────┘  └─────────┘  └─────────┘  └─────────┘    │
│                                                             │
└──────────────┬────────────────────┬─────────────────────────┘
               │ WS tunnel          │ WS tunnel
               │                    │
        ┌──────┴──────┐      ┌─────┴──────┐
        │ Machine A    │      │ VPS / GPU   │
        │ Shell, FS    │      │ Outils      │
        │ Auth flow    │      │ spécialisés │
        └─────────────┘      └────────────┘
```

## Les composants

### 1. Broker (Deno Deploy)

Le Broker est le seul composant qui tourne en dehors d'une Sandbox. C'est le
plan de contrôle. Il fait :

- **LLM Proxy** — Deux modes d'auth, même `fetch()` au final (ADR-002) :
  - **Mode Clé API** : le broker détient les clés (Anthropic, OpenAI, etc.)
  - **Mode OAuth** : token obtenu via flow navigateur (même mécanisme que Claude
    CLI / Codex CLI), stocké sur le Broker
  - L'agent ne sait pas quel mode est utilisé — interface uniforme
    `broker.complete()`
- **Message Router** — Route les tâches et messages A2A vers les agents via HTTP
  POST. KV persiste l'état durable et les traces ; les KV Queues éventuelles ne
  sont qu'un détail interne d'optimisation Broker. Contrôle qui parle à qui
  (permissions A2A).
- **Tunnel Hub** — Mesh réseau à la Tailscale. Maintient les connexions
  WebSocket vers les noeuds (machines, VPS, GPU) et les autres Brokers
  (fédération). Chaque tunnel déclare ses **capabilities** (outils, auth). Le
  broker route selon ces déclarations.
- **Cron Dispatcher** — Un seul `Deno.cron()` statique qui lit les schedules
  agents depuis KV et dispatche par HTTP POST vers les agents concernés.
- **Agent Lifecycle** — Crée, détruit, monitore les agents via l'API Subhosting
  **v2** (Apps/Revisions) et les exécutions via l'API Sandbox (instances
  éphémères).
- **Auth** — `@deno/oidc` pour les agents Subhosting et les tunnels. Credentials
  materialization pour les Sandboxes (ADR-003). Zéro secret statique visé.

### 2. Agents (Deno Subhosting + Sandbox)

Chaque agent = un deployment Subhosting (warm-cached V8 isolate, KV bindé).
L'exécution de code passe par des Sandboxes éphémères.

**Le Subhosting (endpoint stateful réactif)** :

- Se réveille sur HTTP POST du Broker, se rendort quand idle (warm-cached, pas
  un daemon)
- KV bindé pour mémoire et sessions (persiste indépendamment de l'isolate)
- Reçoit les messages du Broker par HTTP, pas par KV Queues (`listenQueue` ne
  fonctionne pas en Subhosting)
- Demande les completions LLM au broker
- Dispatche l'exécution de code vers des Sandboxes
- Persiste les résultats en KV
- N'exécute JAMAIS de code arbitraire
- **Pas de `Deno.cron()`** — les tâches planifiées sont gérées par le Broker

**La Sandbox (exécuteur)** :

- Éphémère (30 min max), créée à la demande
- Permissions hardened, network allowlist (broker seul)
- Pas de secrets (credentials materialization pour l'auth broker, ADR-003)
- Exécute : skills user, outils, code LLM-generated
- Renvoie le résultat et meurt

```typescript
// Côté Subhosting — le runtime agent (réactif, piloté par HTTP du Broker)
class AgentRuntime {
  private broker: BrokerClient;
  private kv: Deno.Kv; // KV bindé, mémoire persistante (survit aux redémarrages isolate)

  // Point d'entrée HTTP — le Broker appelle cet endpoint
  async handleRequest(req: Request): Promise<Response> {
    const msg = await req.json() as BrokerMessage;

    if (msg.type === "user_message") return this.handleMessage(msg);
    if (msg.type === "cron_trigger") return this.handleCron(msg);
    // ... autres types de messages du Broker
  }

  async handleMessage(msg: Message): Promise<Response> {
    // LLM call via broker
    const llmResponse = await this.broker.llmComplete({
      messages: await this.buildContext(msg),
      model: "anthropic/claude-sonnet-4-6",
    });

    // Tool call → exécution en Sandbox via broker
    if (llmResponse.toolCalls) {
      for (const tc of llmResponse.toolCalls) {
        const result = await this.broker.sandboxExec({
          tool: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        });
        await this.kv.set(["results", tc.id], result);
      }
    }

    return Response.json({ content: llmResponse.content });
  }
}
```

### 3. Tunnels (WebSocket)

Le tunnel est le **mesh réseau** de DenoClaw — il connecte tout ce qui n'est pas
sur la même instance Deploy. Comme Tailscale crée un réseau privé entre
machines.

#### Trois types de connexion

| Type                | Relie                    | Usage                                                   |
| ------------------- | ------------------------ | ------------------------------------------------------- |
| **Noeud → Broker**  | Machine/VPS/GPU → Broker | Outils distants (shell, FS, GPU), auth OAuth navigateur |
| **Broker → Broker** | Instance A ↔ Instance B  | Fédération A2A cross-instance                           |
| **Local → Broker**  | Dev machine → Broker     | Outils locaux, auth flow, tests                         |

Les **agents** ne sont jamais directement sur le tunnel — ils passent par leur
Broker via HTTP.

```
Instance A                    Instance B                    Machine locale
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│ Broker A │◄═══ tunnel ════►│ Broker B │                 │ denoclaw │
│  agents  │                 │  agents  │                 │ tunnel   │
└──────────┘                 └──────────┘                 └────┬─────┘
                                                               │
                              VPS (noeud)                      │
                             ┌──────────┐                      │
                             │ Shell/FS │◄══ tunnel ═══════════╝
                             │ GPU      │
                             └──────────┘
```

#### Commandes

```bash
# Connecter ta machine locale au broker
denoclaw tunnel wss://mon-broker.deno.dev/tunnel

# Connecter deux instances entre elles
denoclaw tunnel wss://instance-a.deno.dev/tunnel
```

#### Capabilities

Chaque tunnel déclare ce qu'il expose :

```typescript
// Noeud VPS/machine avec outils
{
  type: "node",
  tools: ["shell", "fs_read", "fs_write"],
  supportsAuth: true,
}

// Broker B (inter-instance, fédération)
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

Le broker maintient un registre des tunnels actifs. Il route selon les
capabilities déclarées.

## Flux complet d'un message

```
1. Utilisateur envoie un message (Telegram, API, webhook)
           │
2. Broker reçoit, crée/récupère une session
           │
3. Broker envoie le message à l'agent via HTTP POST
           │  POST https://<agent>.deno.dev/ { type: "user_message", content: "..." }
           │
4. Agent Subhosting se réveille (ou est déjà warm), traite le message
           │
5. Agent demande un LLM completion au broker (fetch HTTP)
           │  POST https://<broker>/llm { model: "...", messages: [...] }
           │
6. Broker résout le provider :
           │  ├─ model = "anthropic/..." → fetch() avec clé API (broker la détient)
           │  ├─ model = "openai/..."    → fetch() avec clé API
           │  └─ model = "claude-oauth"  → fetch() avec token OAuth (obtenu via flow navigateur one-shot)
           │
7. Broker renvoie la réponse LLM dans la réponse HTTP
           │
8. Si tool_call : agent demande l'exécution au broker (fetch HTTP)
           │  POST https://<broker>/tool { tool: "shell", args: {...} }
           │
9. Broker route vers le bon tunnel (selon les capabilities déclarées)
           │  WebSocket: { tool: "shell", args: {...} }
           │
10. Machine locale exécute, renvoie le résultat via WS
           │
11. Broker renvoie le résultat dans la réponse HTTP
           │
12. Agent continue sa boucle (retour à l'étape 5) ou répond
           │
13. Réponse finale remonte au Broker → utilisateur
```

**Cron / Heartbeat (mode Deploy)** :

```
Broker (Deno.cron) → HTTP POST https://<agent>.deno.dev/cron/heartbeat → Agent se réveille, exécute, répond
```

## Capabilities des tunnels

Chaque tunnel déclare au broker ce qu'il expose :

```typescript
{
  tunnelId: "machine-erwan",
  tools: ["shell", "fs_read", "fs_write"],    // outils locaux exécutables
  supportsAuth: true,                          // peut recevoir des auth requests (ouvre navigateur)
  allowedAgents: ["agent-123", "agent-456"],  // qui peut m'utiliser
}
```

Le broker maintient un registre des tunnels actifs. Quand un agent demande un
outil, le broker cherche un tunnel qui a la capability.

BrokerClient délègue à une interface pluggable `BrokerTransport` (`KvQueueTransport` en local, HTTP/SSE sur le réseau).

## Auth OAuth LLM via tunnel

Quand le Broker utilise le mode OAuth (même flow que Claude CLI / Codex CLI), il
a besoin d'un navigateur pour l'auth initiale. Le tunnel route l'URL vers une
machine locale :

1. Le Broker initie un flow OAuth/device code vers le provider LLM (Anthropic,
   etc.)
2. Il émet
   `{ type: "auth_request", url: "https://auth.anthropic.com/...", code: "ABCD-1234" }`
3. Le tunnel route vers une machine locale avec `supportsAuth: true`
4. La machine locale ouvre le navigateur avec l'URL
5. L'utilisateur se connecte
6. Le token OAuth remonte : tunnel → Broker
7. Le Broker stocke le token (KV ou Secret Manager)

**C'est un one-shot** — après l'auth initiale, le Broker utilise le token OAuth
directement dans ses `fetch()` vers l'API LLM. Pas de CLI exécuté, juste le même
flow d'auth.

## Communication inter-agents

Les agents ne se parlent JAMAIS directement (network isolation). Tout passe par
le Broker qui route via HTTP.

Autrement dit : **A2A over HTTP + SSE, persisted in KV, correlated by task/context ids.**

```typescript
// Agent A veut déléguer une tâche à Agent B — il soumet une tâche au Broker
await broker.submitTask({
  to: "agent-b",
  payload: { instruction: "Analyse ce fichier", data: "..." },
});
// → Le Broker route un message task_submit vers agent-b.deno.dev via HTTP POST

// Agent B reçoit via HTTP (pas listenQueue), traite, continue ou répond via le Broker
await broker.sendTextTask({
  to: "agent-a",
  text: "Analyse terminée",
  payload: { analysis: "..." },
});
```

Le broker vérifie les **permissions** : Agent A a-t-il le droit de parler à
Agent B ?

## Observation d'état (KV Watch)

Le broker expose l'état de chaque agent via KV. N'importe quel composant
autorisé peut observer :

```typescript
// Dashboard ou autre agent observe l'état
for await (
  const entries of kv.watch([
    ["agents", "agent-a", "status"],
    ["agents", "agent-b", "status"],
  ])
) {
  // Temps réel : { task: "analyzing", progress: 0.7 }
}
```

## Sécurité (voir ADR-003)

Principe : **zéro secret statique.** Partout.

| Frontière                         | Mécanisme                                             | Secret statique ?                 |
| --------------------------------- | ----------------------------------------------------- | --------------------------------- |
| Sandbox isolation                 | MicroVM Linux, network allowlist                      | N/A                               |
| Agent (Subhosting) → Broker       | `@deno/oidc` (préféré), fallback Layers/invite        | Non                               |
| Sandbox → Broker                  | Credentials materialization (token invisible au code) | Non                               |
| Broker → Subhosting + Sandbox API | `@deno/oidc` (token éphémère)                         | Non                               |
| Tunnel → Broker                   | OIDC éphémère / token d'invitation à usage unique     | Non                               |
| Broker → LLM API                  | Clé API ou token OAuth (flow navigateur one-shot)     | Non (GCP Secret Manager, ADR-004) |
| Inter-agents                      | Le broker valide chaque message (allowedPeers)        | N/A                               |
| Transport                         | TLS (wss://) pour tous les WebSocket                  | N/A                               |

## Avantages du LLM Proxy centralisé

Le fait que TOUS les calls LLM passent par le broker donne :

- **Tracking de coûts** par agent / par utilisateur
- **Rate limiting** centralisé
- **Fallback chains** (Anthropic down → switch OpenAI)
- **Cache** de réponses identiques
- **Logs** de tous les calls LLM au même endroit
- **Changement de provider** sans toucher aux agents

## Mode local vs Deploy

DenoClaw fonctionne dans les deux modes. Le code est le même, seul
l'environnement change.

|                           | Mode local                                             | Mode Deploy                                      |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Broker / Main             | **Process** Deno principal                             | Deno Deploy                                      |
| Agent runtime             | **Worker** (un par agent)                              | Subhosting (warm-cached V8 isolate)              |
| Exécution code            | **Subprocess** (`Deno.Command`)                        | Sandbox (microVM)                                |
| Transport Broker → Agent  | `postMessage` / `onmessage`                            | HTTP POST                                        |
| Transport Agent → Sandbox | `Deno.Command` (spawn + stdin/stdout)                  | API Sandbox (HTTP)                               |
| KV                        | SQLite par agent (`Deno.openKv("./data/<agent>.db")`)  | FoundationDB (KV bindé via API v2)               |
| Cron / Heartbeat          | Main process `Deno.cron()` → `postMessage` vers Worker | Broker `Deno.cron()` → HTTP POST vers Subhosting |
| LLM                       | Direct fetch() (clés locales)                          | Via broker (LLM Proxy)                           |
| Tunnels                   | Pas nécessaire (tout est local)                        | WebSocket vers machines distantes                |
| Auth                      | Pas nécessaire                                         | OIDC + credentials materialization               |

**Trois niveaux d'isolation en local — Process / Worker / Subprocess :**

- **Process** (main) = le Broker. Détient les crons, route les messages, gère le
  lifecycle.
- **Worker** = un agent. Même contraintes que Subhosting (pas de `Deno.cron()`,
  pas de mémoire partagée, communication par messages). Code agent identique
  dans les deux modes.
- **Subprocess** (`Deno.Command`) = exécution de code isolée. Équivalent local
  du Sandbox (microVM en deploy). Process éphémère avec permissions contrôlées.

Le code agent est identique dans les deux modes — seul le transport change
(`postMessage` vs HTTP, `Deno.Command` vs API Sandbox).

En local, le main process détient les crons (`Deno.cron()`) et dispatche vers
les Workers. En Deploy, le Broker fait pareil via HTTP vers les agents
Subhosting.

## Heartbeat

Le heartbeat est un cron comme un autre — mais son exécution dépend du mode.

**Mode local** — le main process détient le cron, dispatche vers le Worker :

```typescript
// Main process (broker local)
const cron = new CronManager();
await cron.heartbeat(async () => {
  // Envoie au Worker de l'agent
  agentWorker.postMessage({ type: "cron_trigger", job: "heartbeat" });
}, 5);
```

**Mode Deploy** — un seul `Deno.cron()` statique dispatche pour tous les agents
:

```typescript
// Côté Broker (Deno Deploy) — un seul cron, dispatche dynamiquement
Deno.cron("agent-cron-dispatcher", "* * * * *", async () => {
  const kv = await Deno.openKv();
  for await (const entry of kv.list<CronSchedule>({ prefix: ["cron_schedules"] })) {
    if (isDue(entry.value)) {
      await fetch(`https://${entry.value.agentUrl}/cron/${entry.value.job}`, {
        method: "POST",
      });
    }
  }
});

// Côté Agent (Subhosting) — reçoit le HTTP, pas de cron local
async handleCron(req: Request): Promise<Response> {
  // Vérifie s'il y a des tâches en attente
  return Response.json({ status: "ok" });
}
```

L'agent **déclare** ses crons dans sa config, le Broker les **persiste en KV**
et le dispatcher les **évalue chaque minute**. `Deno.cron()` est extrait
statiquement par Deploy — on ne peut pas l'appeler dynamiquement en boucle, d'où
le pattern dispatcher unique.

## Modules à créer

| Module                         | Rôle                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `src/orchestration/broker.ts`  | Broker principal — Deploy, LLM proxy, message router, cron dispatcher       |
| `src/orchestration/gateway.ts` | Gateway HTTP + WebSocket — channels, sessions                               |
| `src/orchestration/auth.ts`    | Auth — @deno/oidc (agents + tunnels), credentials materialization (sandbox) |
| `src/orchestration/client.ts`  | Client HTTP pour communiquer avec le broker (OIDC auth)                     |
| `src/orchestration/relay.ts`   | Mesh tunnel — WS client, capabilities, reconnect                            |
| `src/orchestration/sandbox.ts` | Exécuteur de code en Sandbox — API v2                                       |
| `src/agent/runtime.ts`         | Runtime agent — HTTP handler réactif, KV pour état, appels Broker via fetch |
| `src/agent/cron.ts`            | CronManager — Deno.cron() (Broker/local), déclaration config (agents)       |
| `src/llm/manager.ts`           | LLM provider manager — clé API + OAuth, fallback, routing                   |
| `src/messaging/a2a/`           | Protocole A2A — types, server, client, cards, tasks                         |
| `src/messaging/bus.ts`         | MessageBus — KV Queues (Broker/local only)                                  |

## Ordre d'implémentation

1. **Broker minimal** — LLM proxy (clé API + OAuth) + HTTP router sur Deploy
2. **Agent runtime** — HTTP handler réactif + BrokerClient HTTP (OIDC) + KV état
3. **Workers local** — mode multi-agent local (Process / Worker / Subprocess)
4. **Sandbox executor** — exécution de code hardened
5. **Mesh tunnel** — noeuds, fédération brokers, machines locales
6. **Cron dispatcher** — scheduler KV-based + dispatch HTTP
7. **Inter-agents A2A** — routage HTTP + SSE streaming (tâches longues)
8. **Agent lifecycle** — Subhosting API v2 (Apps/Revisions)
9. **Dashboard** — observation d'état via KV Watch (Broker KV)
