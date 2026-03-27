# DenoClaw

Agent AI Deno-natif. Zéro dépendance Node.js. Inspiré de [nano-claw](https://github.com/hustcc/nano-claw) et [PicoClaw](https://github.com/sipeed/picoclaw).

## Stack

Tout est natif Deno 2.7+ :

| Besoin | API Deno |
|---|---|
| Persistence | `Deno.openKv()` |
| Cron / Heartbeat | `Deno.cron()` |
| File d'attente | `kv.enqueue()` / `kv.listenQueue()` |
| HTTP server | `Deno.serve()` |
| WebSocket | `Deno.upgradeWebSocket()` |
| Shell | `Deno.Command` |
| HTTP client | `fetch()` |
| Tests | `Deno.test()` |
| Observabilité | OpenTelemetry intégré |

## Quickstart

```bash
# Installer Deno 2.7+
curl -fsSL https://deno.land/install.sh | sh

# Configurer un provider LLM (interactif)
deno task start setup provider

# Configurer Telegram
deno task start setup channel

# Chat interactif
deno task start agent

# Message unique
deno task start agent -- -m "Bonjour DenoClaw"

# Utiliser Ollama local
deno task start agent -- --model ollama/nemotron-3-super

# Utiliser Claude CLI
deno task start agent -- --model claude-cli

# Gateway multi-canal (HTTP + WebSocket + Telegram)
deno task start gateway

# Déployer sur Deno Deploy
deno task start publish gateway
```

## Architecture

```
Local  : Main process (broker) → Workers (agents) → Deno.Command (exécution)
Deploy : Broker (Deno Deploy)  → Subhosting (agents) → Sandbox (exécution)
```

- **Broker** = orchestrateur central (LLM proxy, cron, tunnels, inter-agents). Seul composant long-running.
- **Subhosting** = héberge l'agent (warm-cached, KV pour état). Réactif — se réveille sur HTTP du Broker.
- **Sandbox** = exécute le code (éphémère, permissions hardened)
- **Local** : Workers (= Subhosting) + `Deno.Command` (= Sandbox), même code, `postMessage` au lieu de HTTP
- **Tunnels** = WebSocket vers machines locales (Codex CLI, Claude CLI)

Voir `docs/architecture-distributed.md` et les ADRs dans `docs/`.

## Pattern AX (Agent Experience)

Toute interface est conçue pour des agents, pas juste des humains :

- Erreurs structurées : `{ code, context, recovery }`
- Safe defaults : `dry_run: true` sur les écritures
- Enums au lieu de strings libres
- Boucle Plan → Scope → Act → Verify → Recover

Voir `CLAUDE.md` pour les conventions complètes.

## Développement

```bash
deno task dev       # Dev avec watch
deno task test      # Tests
deno task check     # Type-check
deno task lint      # Lint
deno task fmt       # Format
```

## Structure

```
src/
├── agent/          # Boucle ReAct, mémoire (KV), skills, context
│   └── tools/      # Shell, file, web, registry
├── providers/      # Anthropic, OpenAI-compat, manager
├── bus/            # MessageBus (KV Queues)
├── session/        # Sessions (KV)
├── channels/       # Console, webhook, manager
├── gateway/        # HTTP + WebSocket (Deno.serve)
├── cron/           # Deno.cron + heartbeat
├── sandbox/        # API Deno Sandbox
├── telemetry/      # OpenTelemetry
├── config/         # Chargement, validation, env vars
└── utils/          # Logger, helpers, erreurs structurées
docs/
├── architecture-distributed.md
├── adr-001-all-agents-in-sandbox.md
├── adr-002-llm-proxy-on-broker.md
└── adr-003-auth-oidc-and-credentials-materialization.md
```

## Licence

MIT
