# ADR-007 : Dashboard temps réel + observabilité profonde des agents

**Statut :** Proposé **Date :** 2026-03-27

## Contexte

Le broker voit passer tous les messages (LLM, tools, A2A) mais aujourd'hui les
métriques sont des compteurs agrégés (/stats). On veut voir **en temps réel et
en détail** ce qui se passe :

- L'état de chaque agent et tunnel
- Chaque action à l'intérieur de la boucle agent (pas juste le résultat final)
- Le graphe de communication A2A en live

## Décision

### 1. Dashboard Fresh avec KV Watch

Un dashboard web (Deno Fresh) qui observe le KV en temps réel via `kv.watch()`.
Pas de polling, pas de WebSocket custom — lecture directe du KV.

### 2. Observabilité profonde : tracer la boucle agent

Aujourd'hui on trace les appels LLM et tools au niveau du broker. Mais on ne
voit pas ce qui se passe **à l'intérieur** de l'agent :

```
Ce qu'on voit aujourd'hui :
  agent "coder" → llm_request → llm_response → tool_request → tool_response

Ce qu'on veut voir :
  agent "coder" boucle ReAct
    ├── itération 1
    │   ├── context build (12 messages, 3 skills, 4 tools)
    │   ├── LLM call (claude-sonnet-4-6, 2847 tokens in, 342 out, 1.2s)
    │   ├── tool_call: shell { command: "deno test" }
    │   │   ├── sandbox créée (perms: [run], 256MB)
    │   │   ├── exécution (1.8s, exit 0)
    │   │   └── sandbox détruite
    │   └── résultat tool → continue
    ├── itération 2
    │   ├── LLM call (342 tokens in, 89 out, 0.6s)
    │   └── réponse finale : "Tests passed."
    └── terminé (2 itérations, 3.6s total, $0.012)
```

### Comment tracer la boucle agent

L'AgentRuntime dans le Subhosting écrit ses traces dans le KV au fil de
l'exécution :

```typescript
// Chaque étape de la boucle agent est persistée en KV
await kv.set(["traces", agentId, taskId, "iteration", 1, "llm_call"], {
  model: "claude-sonnet-4-6",
  tokensIn: 2847,
  tokensOut: 342,
  latencyMs: 1200,
  timestamp: "...",
});

await kv.set(["traces", agentId, taskId, "iteration", 1, "tool_call", 0], {
  tool: "shell",
  args: { command: "deno test" },
  sandboxPerms: ["run"],
  success: true,
  latencyMs: 1800,
  timestamp: "...",
});
```

Le dashboard `kv.watch()` ces clés et affiche l'arbre en temps réel. On voit
littéralement l'agent "penser" — chaque itération, chaque appel, chaque outil.

### Structure des traces dans KV

```
["traces", agentId, taskId]                        → métadonnées task
["traces", agentId, taskId, "iteration", N]        → résumé itération
["traces", agentId, taskId, "iteration", N, "llm_call"]    → détail LLM
["traces", agentId, taskId, "iteration", N, "tool_call", M] → détail outil
["traces", agentId, taskId, "result"]              → résultat final
```

### Vues du dashboard

**1. Vue réseau** — graphe des agents et tunnels

```
┌─researcher─┐     ┌──coder──┐
│ ● alive    │────►│ ● working│
│ 3 tasks    │     │ 1 tool   │
└────────────┘     └────┬─────┘
                        │
                   ┌────┴─────┐
                   │ tunnel   │
                   │ local    │
                   │ ● online │
                   └──────────┘
```

**2. Vue agent** — boucle ReAct en live

- Arbre des itérations, LLM calls, tool calls
- Tokens, coûts, latences
- Contenu des messages (expandable)

**3. Vue métriques** — graphes temporels

- Tokens/heure par agent
- Coût cumulé
- Latence p50/p95
- Tool success rate

**4. Vue A2A** — flux de tasks entre agents

- Tasks en cours, complétées, échouées
- Graphe de dépendances

### Lien avec OTEL

Les spans OTEL qu'on a déjà (spanAgentLoop, spanLLMCall, spanToolCall) peuvent
être exportés vers un backend OTEL (Grafana, Jaeger). Le dashboard Fresh est
complémentaire — il montre l'état live via KV Watch, les spans OTEL montrent les
traces historiques.

```
Temps réel : KV Watch → Dashboard Fresh
Historique  : OTEL spans → Grafana / Jaeger
```

## Modules à créer

| Module                         | Rôle                                         |
| ------------------------------ | -------------------------------------------- |
| `src/telemetry/traces.ts`      | Écriture des traces détaillées dans KV       |
| `web/routes/index.tsx`         | Dashboard principal (Fresh)                  |
| `web/routes/agents/[id].tsx`   | Vue détaillée d'un agent                     |
| `web/routes/network.tsx`       | Vue réseau (graphe)                          |
| `web/routes/api/watch.ts`      | SSE endpoint qui expose KV Watch au frontend |
| `web/islands/AgentTrace.tsx`   | Composant interactif arbre de trace          |
| `web/islands/NetworkGraph.tsx` | Graphe réseau interactif                     |

## Conséquences

- Les traces détaillées consomment du KV — il faut un TTL et du cleanup (traces
  > 24h supprimées)
- Le dashboard Fresh est optionnel — le broker fonctionne sans
- Chaque AgentRuntime doit écrire ses traces dans le KV (ajout dans la boucle
  agent)
- C'est comme OpenClaw qui trace les appels d'outils, mais en plus profond (on
  voit chaque itération de la boucle ReAct)
