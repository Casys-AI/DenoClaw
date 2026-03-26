# ADR-006 : A2A (Agent-to-Agent) pour la communication inter-agents

**Statut :** Accepté
**Date :** 2026-03-27

## Contexte

Les agents DenoClaw doivent pouvoir se déléguer des tâches entre eux, que ce soit au sein du même déploiement ou avec des agents externes. La question : quel protocole pour cette communication ?

## Options considérées

1. **Format custom BrokerMessage** — ce qu'on a actuellement
2. **A2A (Agent-to-Agent)** — protocole ouvert Google/Linux Foundation, v1.0
3. **MCP** — Model Context Protocol d'Anthropic

## Décision

**A2A pour l'inter-agents. MCP pour les outils.**

- A2A = horizontal (agent ↔ agent) — délégation de tâches entre pairs
- MCP = vertical (agent → tools) — accès aux outils et données

Les deux coexistent. Un agent DenoClaw utilise MCP pour ses outils internes et A2A pour parler à d'autres agents.

## A2A en bref

**Transport :** JSON-RPC 2.0 sur HTTPS + SSE pour le streaming.

**Objets clés :**

| Objet | Rôle |
|---|---|
| AgentCard | "Carte de visite" publiée à `/.well-known/agent-card.json` — skills, endpoint, auth |
| Task | Unité de travail, avec lifecycle : submitted → working → completed/failed |
| Message | Communication dans une Task : role (user/agent) + Parts |
| Part | Contenu atomique : TextPart, FilePart, DataPart, FunctionCallPart |
| Artifact | Output produit par une Task, composé de Parts |
| Skill | Capability déclarée sur l'AgentCard |

**Lifecycle d'une Task :**
```
submitted → working → completed
                    → failed
                    → canceled
           input_required ↔ working (multi-turn)
```

**Méthodes RPC :**
- `message/send` — envoyer un message, recevoir la réponse sync
- `message/stream` — envoyer, recevoir en SSE (streaming)
- `tasks/get` — poll le statut
- `tasks/cancel` — annuler
- `tasks/pushNotificationConfig/set` — webhook pour async long-running

## Mapping sur DenoClaw

| DenoClaw actuel | A2A |
|---|---|
| `AgentEntry` (registry) | `AgentCard` (skills, capabilities) |
| `BrokerMessage` (custom) | JSON-RPC 2.0 `message/send` |
| `ChannelMessage` | A2A `Message` avec `Parts` |
| `Skill` type | A2A `AgentSkill` (+ id, tags, examples) |
| KV Queue routing | Broker route les Tasks A2A entre agents |
| WebSocket streaming | SSE via `Deno.serve()` + `ReadableStream` |

## Architecture

```
Agent "researcher" (Subhosting)     Broker (Deploy)         Agent "coder" (Subhosting)
     │                                   │                       │
     │ /.well-known/agent-card.json      │                       │ /.well-known/agent-card.json
     │ skills: [research, analyze]       │                       │ skills: [code, test, review]
     │                                   │                       │
     │  A2A message/send                 │                       │
     │  Task: "write code for finding"   │                       │
     ├──────── KV Queue ────────────────►│                       │
     │                                   │  route vers "coder"   │
     │                                   ├──── KV Queue ────────►│
     │                                   │                       │ exécute
     │                                   │                       │ (working → completed)
     │                                   │◄──── KV Queue ────────┤
     │◄──────── KV Queue ───────────────┤  Task result           │
```

Chaque agent Subhosting expose un endpoint A2A. Le broker peut :
1. Router les Tasks entre agents internes (via KV Queues)
2. Recevoir des Tasks d'agents externes (via HTTP)
3. Envoyer des Tasks vers des agents externes (via HTTP)

## Agent Card DenoClaw

Chaque agent du registry génère automatiquement son Agent Card :

```json
{
  "name": "coder",
  "description": "Écrit et exécute du code",
  "version": "1.0.0",
  "protocolVersion": "1.0",
  "url": "https://denoclaw-coder.deno.dev/a2a",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "authentication": { "schemes": ["Bearer"] },
  "skills": [
    {
      "id": "shell_exec",
      "name": "Shell Execution",
      "description": "Execute shell commands in sandbox",
      "tags": ["coding", "shell"]
    },
    {
      "id": "file_write",
      "name": "File Operations",
      "description": "Read and write files",
      "tags": ["coding", "files"]
    }
  ]
}
```

## Implémentation (Deno natif, zéro dep)

Pas besoin de SDK A2A — le protocole est JSON-RPC 2.0 sur HTTP, implémentable avec `Deno.serve()` et `fetch()` :

**Serveur A2A (exposer un agent) :**
```typescript
Deno.serve((req) => {
  const url = new URL(req.url);

  // Discovery
  if (url.pathname === "/.well-known/agent-card.json") {
    return Response.json(agentCard);
  }

  // JSON-RPC endpoint
  if (url.pathname === "/a2a" && req.method === "POST") {
    const rpc = await req.json();
    switch (rpc.method) {
      case "message/send": return handleSend(rpc);
      case "message/stream": return handleStream(rpc);
      case "tasks/get": return handleGetTask(rpc);
      case "tasks/cancel": return handleCancel(rpc);
    }
  }
});
```

**Client A2A (appeler un agent) :**
```typescript
const card = await fetch("https://agent.dev/.well-known/agent-card.json").then(r => r.json());

const result = await fetch(card.url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: "Write a test for this function" }]
      }
    }
  })
}).then(r => r.json());
```

## Modules implémentés

| Module | Rôle | Statut |
|---|---|---|
| `src/a2a/types.ts` | Types A2A v1.0 complets (AgentCard, Task, Message, Part, Skill, JSON-RPC, SSE) | **fait** |
| `src/a2a/server.ts` | Serveur A2A : JSON-RPC (message/send, message/stream, tasks/get, tasks/cancel) + SSE streaming | **fait** |
| `src/a2a/client.ts` | Client A2A : discover, send, stream (async generator SSE), getTask, cancelTask | **fait** |
| `src/a2a/card.ts` | Génération d'AgentCard depuis le registry config (permissions → skills) | **fait** |
| `src/a2a/tasks.ts` | Task store KV (lifecycle SUBMITTED→WORKING→COMPLETED/FAILED, artifacts, terminal state protection) | **fait** |
| `src/broker/server.ts` | Peer verification (PEER_NOT_ALLOWED, PEER_REJECTED) dans le routage inter-agents | **fait** |

## Conséquences

- Chaque agent DenoClaw est interopérable avec tout agent A2A (LangChain, Bedrock, etc.)
- Le format custom `BrokerMessage` reste pour le transport interne (KV Queues) mais les payloads s'alignent sur A2A
- L'AgentCard est générée automatiquement depuis la config agent (registry)
- Le streaming SSE est natif Deno, pas besoin de lib
- Compatible avec le routing channel → agent(s) : le broker est un routeur A2A
