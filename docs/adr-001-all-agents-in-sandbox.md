# ADR-001 : Agents en Subhosting, exécution de code en Sandbox

**Statut :** Accepté
**Date :** 2026-03-26

## Contexte

DenoClaw doit exécuter des agents AI qui utilisent des LLM, des outils (shell, fichiers, CLI), et communiquent entre eux. La question est : quel modèle d'hébergement et d'isolation pour les agents ?

## Options considérées

1. **Web Workers** — threads isolés dans le même process Deno (rejeté pour deploy, **retenu pour le mode local**)
2. **Tout en Sandbox** — microVMs Linux pour tout
3. **Broker + Subhosting + Sandbox** — Broker orchestre, Subhosting pour l'agent, Sandbox pour l'exécution de code

## Décision

**Trois couches, chacune avec son rôle :**

- **Broker** (Deno Deploy) — orchestre tout : cron, message routing, agent lifecycle. Seul composant long-running.
- **Deno Subhosting** — héberge l'agent (warm-cached V8 isolate, KV bindé pour état/mémoire). Se réveille sur HTTP du Broker, se rendort quand idle. Pas de `Deno.cron()`, pas de `listenQueue()`.
- **Deno Sandbox** — exécute le code de l'agent avec des permissions hardened (skills, outils, code LLM-generated)

Aucun code ne s'exécute directement dans le Subhosting. Le runtime agent dans le Subhosting est un endpoint réactif — il reçoit les messages par HTTP du Broker, appelle le broker pour le LLM, et délègue toute exécution de code à une Sandbox éphémère.

> **API Subhosting** : utiliser **v2** (`api.deno.com/v2`). La v1 sunset en juillet 2026.

## Architecture

```
┌─── Broker (Deno Deploy) ────────────────────────────────┐
│  Orchestre : cron, routing, lifecycle                    │
│  Long-running, Deno.cron() + KV Queues disponibles      │
│                                                         │
│  HTTP POST → Agent Subhosting                           │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│  Subhosting (Agent) — warm-cached V8 isolate            │
│                                                         │
│  Agent runtime (notre code, logique réactive)           │
│  KV bindé (mémoire, sessions, état — persiste toujours) │
│  Se réveille sur HTTP, se rendort quand idle            │
│                                                         │
│  Quand il faut exécuter du code :                       │
│  └─→ Sandbox (microVM éphémère)                         │
│       - Permissions hardened                             │
│       - Network allowlist (broker seul)                  │
│       - Pas de secrets                                   │
│       - 30 min max                                       │
│       - Skills user, code LLM-generated, outils          │
│       └─→ exécute le code, renvoie le résultat          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Rôle de chaque couche

| | Broker (Deploy) | Subhosting (l'agent) | Sandbox (l'exécution) |
|---|---|---|---|
| Durée de vie | Long-running | Warm-cached (dort quand idle) | Éphémère, 30 min max |
| KV | Oui (routing, état global) | Bindé (mémoire, sessions) | Aucun (éphémère) |
| Cron | Oui (`Deno.cron()`) | **Non** | Non |
| Queues | Oui (`listenQueue()`) | **Non** | Non |
| Rôle | Orchestration, cron, routing | État agent, logique réactive | Exécution de code |
| Code exécuté | Broker uniquement | Notre runtime agent uniquement | Skills, outils, code LLM |
| Isolation | Deno Deploy | V8 isolate (par deployment) | MicroVM Linux (hardened) |
| Secrets | Clés API LLM | Credentials materialization (ADR-003) | Aucun, jamais |
| Réseau | Public (endpoints) | Broker seulement | Broker seulement (allowlist) |

## Justification

- **Séparation orchestration / état / exécution** — le Broker orchestre, l'agent gère l'état, la Sandbox exécute le code
- **Warm-cached + éphémère** — l'agent se réveille sur requête (Subhosting), l'exécution est ponctuelle (Sandbox 30 min max). Le Broker est le seul composant long-running.
- **KV bindé** — chaque agent Subhosting a un KV bindé explicitement (créé via API v2) pour mémoire et sessions. Le KV persiste indépendamment de l'isolate.
- **Permissions hardened** — le code s'exécute dans la couche la plus sécurisée (microVM), pas dans l'agent
- **Un seul modèle** — pas de distinction "code de confiance" vs "code non fiable", tout passe par la Sandbox
- **Coût maîtrisé** — Subhosting disponible sur le free tier (1M req/mois, 60 deploys/h). Builder à $200/mois pour la prod (20M req, 300 deploys/h). Sandbox facturé uniquement pendant l'exécution

## Conséquences

- Le runtime agent dans Subhosting est léger et réactif : réception HTTP, appels broker, dispatch vers Sandbox
- L'agent n'a pas de boucle interne — c'est le Broker qui pilote chaque étape par HTTP
- Chaque exécution de code crée une instance Sandbox → latence de boot (~1s) à chaque tool call
- Le Broker gère le cycle de vie des trois couches : crons/routing (lui-même), Subhosting (CRUD agents via API v2), Sandbox (CRUD exécutions)
- Les Sandboxes ne conservent rien — tout résultat doit remonter au Subhosting via le broker pour être persisté en KV
- L'isolate Subhosting reste warm entre des appels rapprochés (burst pendant une tâche), mais s'éteint après idle

## Mode local — Process / Worker / Subprocess

En local, le même modèle 3 couches s'applique avec des primitives Deno :

| Deploy | Local | Rôle |
|---|---|---|
| Broker (Deno Deploy) | **Process** (main) | Orchestre, cron, routing |
| Subhosting (V8 isolate) | **Worker** (`new Worker()`) | Agent, état en KV local |
| Sandbox (microVM) | **Subprocess** (`Deno.Command`) | Exécution de code isolée |

Les Workers sont le bon choix local : mêmes contraintes que Subhosting (pas de cron, pas de mémoire partagée, `postMessage` ≈ HTTP). La transition Worker → Subhosting est quasi transparente. Les subprocesses (`Deno.Command`) offrent une isolation par process (permissions Deno, timeout, env séparé) — équivalent local des microVMs Sandbox.
