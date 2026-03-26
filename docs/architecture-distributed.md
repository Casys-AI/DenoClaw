# Architecture distribuée DenoClaw

## Principe fondamental

**L'agent vit en Subhosting. Il exécute son code en Sandbox.**

Deux couches, chacune avec son rôle (ADR-001) :
- **Subhosting** = l'agent (long-running, KV propre, orchestration, écoute les messages)
- **Sandbox** = l'exécution (éphémère, permissions hardened, code skills/outils/LLM-generated)

Aucun code ne s'exécute directement dans le Subhosting. Tout passe par une Sandbox avec des permissions verrouillées.

## Vue d'ensemble

```
┌─────────────────── DENO DEPLOY (Broker) ───────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────┐       │
│  │              LLM Gateway / Proxy                 │       │
│  │  Mode API : clés sur le broker → fetch()         │       │
│  │  Mode CLI : route vers tunnel → Codex/Claude CLI │       │
│  │  Rate limiting, coûts, fallback, cache, logs     │       │
│  └──────────────────────┬──────────────────────────┘       │
│                         │                                   │
│  ┌──────────────────────┴──────────────────────────┐       │
│  │              Message Router                      │       │
│  │  KV Queues = transport durable inter-agents      │       │
│  │  KV Watch = observation temps réel d'état        │       │
│  │  WebSocket hub = tunnels vers local/VPS          │       │
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
        │ Claude CLI   │      │ Outils      │
        │ Codex CLI    │      │ spécialisés │
        │ FS local     │      │             │
        └─────────────┘      └────────────┘
```

## Les composants

### 1. Broker (Deno Deploy)

Le Broker est le seul composant qui tourne en dehors d'une Sandbox. C'est le plan de contrôle. Il fait :

- **LLM Proxy (dual mode)** — Deux chemins pour les completions LLM :
  - **Mode API** : le broker détient les clés (Anthropic, OpenAI, etc.), fait le fetch() directement
  - **Mode CLI via tunnel** : route vers un tunnel WS → la machine locale exécute Codex CLI ou Claude CLI (qui gèrent leur propre auth)
  - L'agent ne sait pas quel mode est utilisé — interface uniforme `broker.complete()`
- **Message Router** — Route les messages entre agents via KV Queues. Contrôle qui parle à qui (permissions). Même mécanisme pour LLM, outils, et inter-agents.
- **Tunnel Hub** — Maintient les connexions WebSocket vers les machines locales / VPS. Chaque tunnel déclare ses **capabilities** (providers CLI, outils). Le broker route selon ces déclarations.
- **Agent Lifecycle** — Crée, détruit, monitore les agents via l'API Subhosting (deployments) et les exécutions via l'API Sandbox (instances éphémères).
- **Auth** — `@deno/oidc` pour les tunnels, credentials materialization pour les agents (ADR-003). Zéro secret statique sauf les clés API LLM.

### 2. Agents (Deno Subhosting + Sandbox)

Chaque agent = un deployment Subhosting (long-running, KV propre). L'exécution de code passe par des Sandboxes éphémères.

**Le Subhosting (orchestrateur)** :
- Vit en permanence, KV propre pour mémoire et sessions
- Écoute les messages via KV Queues
- Demande les completions LLM au broker
- Dispatche l'exécution de code vers des Sandboxes
- Persiste les résultats en KV
- N'exécute JAMAIS de code arbitraire

**La Sandbox (exécuteur)** :
- Éphémère (30 min max), créée à la demande
- Permissions hardened, network allowlist (broker seul)
- Pas de secrets (credentials materialization pour l'auth broker, ADR-003)
- Exécute : skills user, outils, code LLM-generated
- Renvoie le résultat et meurt

```typescript
// Côté Subhosting — le runtime agent orchestrateur
class AgentRuntime {
  private broker: BrokerClient;
  private kv: Deno.Kv;  // KV propre, mémoire persistante

  async handleMessage(msg: Message): Promise<AgentResponse> {
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
        await this.kv.set(["results", tc.id], result);  // persiste en KV
      }
    }

    return { content: llmResponse.content };
  }
}
```

### 3. Tunnels (WebSocket)

Un tunnel connecte une machine (locale ou VPS) au broker. Le tunnel expose des **capabilities** — la liste des outils disponibles sur cette machine.

```typescript
// Sur ta machine — expose Claude CLI, Codex, FS local
const tunnel = new LocalRelay({
  brokerUrl: "wss://denoclaw-broker.deno.dev/tunnel",
  // Auth : token d'invitation à usage unique → échangé contre un token de session éphémère
  inviteToken: "one-time-use-token",
  capabilities: {
    providers: ["codex-cli", "claude-cli"],
    tools: ["shell", "fs_read", "fs_write"],
  },
});

tunnel.onToolCall(async (req) => {
  // Le broker envoie un tool_call d'un agent Sandbox
  // Tu peux approuver/refuser ici
  return await localTools.execute(req.tool, req.args);
});

await tunnel.connect();
```

## Flux complet d'un message

```
1. Utilisateur envoie un message (Telegram, API, webhook)
           │
2. Broker reçoit, crée/récupère une session
           │
3. Broker enqueue le message vers l'agent Sandbox
           │  KV Queue: { to: "agent-123", type: "user_message", content: "..." }
           │
4. Agent Sandbox reçoit le message via listenQueue
           │
5. Agent demande un LLM completion au broker
           │  KV Queue: { to: "broker", type: "llm_request", model: "...", messages: [...] }
           │
6. Broker résout le provider :
           │  ├─ model = "anthropic/..." → MODE API : fetch() avec clé (broker la détient)
           │  ├─ model = "openai/..."    → MODE API : fetch() avec clé
           │  ├─ model = "codex-cli"     → MODE CLI : route vers tunnel WS → machine locale
           │  └─ model = "claude-cli"    → MODE CLI : route vers tunnel WS → machine locale
           │                               (le CLI local gère sa propre auth)
           │
7. Broker renvoie la réponse à l'agent
           │  KV Queue: { to: "agent-123", type: "llm_response", ... }
           │
8. Si tool_call : agent demande l'exécution au broker
           │  KV Queue: { to: "broker", type: "tool_request", tool: "shell", args: {...} }
           │
9. Broker route vers le bon tunnel (selon les capabilities déclarées)
           │  WebSocket: { tool: "shell", args: {...} }
           │
10. Machine locale exécute, renvoie le résultat via WS
           │
11. Broker renvoie le résultat à l'agent
           │  KV Queue: { to: "agent-123", type: "tool_response", result: {...} }
           │
12. Agent continue sa boucle (retour à l'étape 5) ou répond
           │
13. Broker envoie la réponse finale à l'utilisateur
```

## Capabilities des tunnels

Chaque tunnel déclare au broker ce qu'il expose :

```typescript
{
  tunnelId: "machine-erwan",
  providers: ["codex-cli", "claude-cli"],     // providers LLM via CLI
  tools: ["shell", "fs_read", "fs_write"],    // outils locaux
  allowedAgents: ["agent-123", "agent-456"],  // qui peut m'utiliser
}
```

Le broker maintient un registre des tunnels actifs. Quand un agent demande un provider CLI ou un outil, le broker cherche un tunnel qui a la capability. Si le tunnel tombe, le broker peut fallback (ex: `codex-cli` → `openai/gpt-4o` en API).

## Communication inter-agents

Les agents Sandbox ne se parlent JAMAIS directement (network isolation). Tout passe par le broker via KV Queues.

```typescript
// Agent A veut déléguer une tâche à Agent B
await broker.sendToAgent({
  to: "agent-b",
  type: "task",
  payload: { instruction: "Analyse ce fichier", data: "..." },
});

// Agent B reçoit via son listenQueue
// Agent B répond via le broker
await broker.sendToAgent({
  to: "agent-a",
  type: "task_result",
  payload: { analysis: "..." },
});
```

Le broker vérifie les **permissions** : Agent A a-t-il le droit de parler à Agent B ?

## Observation d'état (KV Watch)

Le broker expose l'état de chaque agent via KV. N'importe quel composant autorisé peut observer :

```typescript
// Dashboard ou autre agent observe l'état
for await (const entries of kv.watch([
  ["agents", "agent-a", "status"],
  ["agents", "agent-b", "status"],
])) {
  // Temps réel : { task: "analyzing", progress: 0.7 }
}
```

## Sécurité (voir ADR-003)

Principe : **zéro secret statique sauf quand c'est imposé** (clés API LLM).

| Frontière | Mécanisme | Secret statique ? |
|---|---|---|
| Sandbox isolation | MicroVM Linux, network allowlist | N/A |
| Sandbox → Broker | Credentials materialization (token invisible au code) | Non |
| Broker → Sandbox API | `@deno/oidc` (token éphémère) | Non |
| Tunnel → Broker | OIDC éphémère / token d'invitation à usage unique | Non |
| Broker → LLM API | API key (env var chiffrée Deploy) | Oui (imposé) |
| Inter-agents | Le broker valide chaque message (allowedPeers) | N/A |
| Capabilities tunnels | Chaque tunnel déclare ce qu'il expose | N/A |
| Transport | TLS (wss://) pour tous les WebSocket | N/A |

## Avantages du LLM Proxy centralisé

Le fait que TOUS les calls LLM passent par le broker donne :
- **Tracking de coûts** par agent / par utilisateur
- **Rate limiting** centralisé
- **Fallback chains** (Anthropic down → switch OpenAI)
- **Cache** de réponses identiques
- **Logs** de tous les calls LLM au même endroit
- **Changement de provider** sans toucher aux agents

## Mode local vs Deploy

DenoClaw fonctionne dans les deux modes. Le code est le même, seul l'environnement change.

| | Mode local | Mode Deploy |
|---|---|---|
| Agent runtime | Process Deno local | Subhosting (deployment) |
| Exécution code | Deno.Command local | Sandbox (microVM) |
| KV | SQLite local (Deno.openKv()) | FoundationDB (Deno.openKv()) |
| Cron / Heartbeat | Deno.cron() (--unstable-cron) | Deno.cron() natif |
| Message bus | KV Queues local | KV Queues Deploy |
| LLM | Direct fetch() (clés locales) | Via broker (LLM Proxy) |
| Tunnels | Pas nécessaire (tout est local) | WebSocket vers machines distantes |
| Auth | Pas nécessaire | OIDC + credentials materialization |

Le même `CronManager` utilise `Deno.cron()` dans les deux cas (flag `--unstable-cron` requis en local). Le même `MessageBus` : KV Queues si KV disponible, in-memory sinon.

## Heartbeat

Le heartbeat n'est pas un module séparé — c'est un cron comme un autre.

```typescript
// L'agent se réveille toutes les 5 minutes
const cron = new CronManager();
await cron.heartbeat(async () => {
  // Vérifie s'il y a des tâches en attente
  // Envoie des messages proactifs si nécessaire
  // Check l'état des tunnels connectés
}, 5);
```

Fonctionne en local (`--unstable-cron`) et sur Deploy (natif). Même API, même comportement.

## Modules à créer

| Module | Rôle |
|---|---|
| `src/broker/server.ts` | Broker principal — Deploy, LLM proxy, message router |
| `src/broker/llm_proxy.ts` | LLM Gateway — clés API, rate limit, fallback, cache |
| `src/broker/router.ts` | Message router — KV Queues, permissions inter-agents |
| `src/broker/tunnel_hub.ts` | Hub WebSocket — gère les tunnels vers local/VPS |
| `src/broker/agent_lifecycle.ts` | CRUD agents — Subhosting (deployments) + Sandbox (exécutions) |
| `src/broker/auth.ts` | Auth — @deno/oidc, credentials materialization, tokens éphémères |
| `src/subhosting/agent_runtime.ts` | Runtime agent dans le Subhosting — orchestrateur, KV, écoute messages |
| `src/subhosting/broker_client.ts` | Client pour communiquer avec le broker depuis le Subhosting |
| `src/sandbox/executor.ts` | Exécuteur de code en Sandbox — skills, outils, code LLM |
| `src/relay/local.ts` | Relay local — WS client vers broker, exécute les outils |
| `src/relay/tunnel.ts` | Config tunnel — capabilities, auth, reconnect |

## Ordre d'implémentation

1. **Broker minimal** — LLM proxy + message router sur Deploy
2. **Agent runtime Subhosting** — BrokerClient + boucle agent + KV
3. **Sandbox executor** — exécution de code hardened
4. **Relay local** — tunnel WS + exécution d'outils
5. **Inter-agents** — routage de messages entre agents
6. **Agent lifecycle** — API pour créer/détruire des agents
7. **Dashboard** — observation d'état via KV Watch
