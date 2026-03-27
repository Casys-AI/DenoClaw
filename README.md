<p align="center">
  <img src="web/static/logo.png" alt="DenoClaw" width="128" />
</p>

# DenoClaw

Agent AI Deno-natif. Zéro dépendance Node.js. Inspiré de
[nano-claw](https://github.com/hustcc/nano-claw) et
[PicoClaw](https://github.com/sipeed/picoclaw).

## Stack

Tout est natif Deno 2.7+ :

| Besoin           | API Deno                                                |
| ---------------- | ------------------------------------------------------- |
| Persistence      | `Deno.openKv()`                                         |
| Cron / Heartbeat | `Deno.cron()` (Broker/local only)                       |
| File d'attente   | `kv.enqueue()` / `kv.listenQueue()` (Broker/local only) |
| HTTP server      | `Deno.serve()`                                          |
| WebSocket        | `Deno.upgradeWebSocket()`                               |
| Shell            | `Deno.Command`                                          |
| HTTP client      | `fetch()`                                               |
| Tests            | `Deno.test()`                                           |
| Observabilité    | OpenTelemetry intégré                                   |

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

- **Broker** = orchestrateur central (LLM proxy, cron, tunnels, inter-agents).
  Seul composant long-running.
- **Subhosting** = héberge l'agent (warm-cached, KV pour état). Réactif — se
  réveille sur HTTP du Broker.
- **Sandbox** = exécute le code (éphémère, permissions hardened)
- **Local** : Workers (= Subhosting) + `Deno.Command` (= Sandbox), même code,
  `postMessage` au lieu de HTTP
- **Tunnels** = mesh réseau (noeuds VPS/GPU, inter-brokers, machines locales) —
  à la Tailscale

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
├── agent/          # Boucle ReAct, runtime, cron, mémoire (KV), skills, context
│   └── tools/      # Shell, file, web, registry
├── llm/            # Providers LLM : Anthropic, OpenAI, Ollama, CLI/OAuth
├── messaging/      # Communication
│   ├── a2a/        # Protocole A2A (JSON-RPC, SSE, AgentCards, Tasks)
│   └── channels/   # Console, webhook, Telegram
├── orchestration/  # Broker, gateway, auth, relay, sandbox, client
├── cli/            # Commandes CLI (setup, agents, publish)
├── config/         # Chargement, validation, env vars
├── shared/         # Logger, helpers, erreurs structurées
└── telemetry/      # OpenTelemetry
docs/
├── architecture-distributed.md
├── adr-001 → adr-008
└── refactor-ddd.md
```

## Licence

MIT
