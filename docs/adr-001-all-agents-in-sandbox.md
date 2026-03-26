# ADR-001 : Agents en Subhosting, exécution de code en Sandbox

**Statut :** Accepté
**Date :** 2026-03-26

## Contexte

DenoClaw doit exécuter des agents AI qui utilisent des LLM, des outils (shell, fichiers, CLI), et communiquent entre eux. La question est : quel modèle d'hébergement et d'isolation pour les agents ?

## Options considérées

1. **Web Workers** — threads isolés dans le même process Deno
2. **Tout en Sandbox** — microVMs Linux pour tout
3. **Subhosting + Sandbox** — Subhosting pour l'agent, Sandbox pour l'exécution de code

## Décision

**Deux couches, chacune avec son rôle :**

- **Deno Subhosting** — héberge l'agent (long-running, KV propre, écoute les messages)
- **Deno Sandbox** — exécute le code de l'agent avec des permissions hardened (skills, outils, code LLM-generated)

Aucun code ne s'exécute directement dans le Subhosting. Le runtime agent dans le Subhosting est un orchestrateur — il reçoit les messages, appelle le broker pour le LLM, et délègue toute exécution de code à une Sandbox éphémère.

## Architecture

```
┌─── Subhosting (Agent) ─────────────────────────────────┐
│                                                         │
│  Agent runtime (notre code, orchestration pure)         │
│  KV propre (mémoire, sessions, état)                    │
│  Écoute KV Queues en permanence                         │
│  Long-running, permanent                                │
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

| | Subhosting (l'agent) | Sandbox (l'exécution) |
|---|---|---|
| Durée de vie | Permanent, long-running | Éphémère, 30 min max |
| KV | Propre (mémoire, sessions) | Aucun (éphémère) |
| Rôle | Orchestration, état, routing | Exécution de code |
| Code exécuté | Notre runtime agent uniquement | Skills, outils, code LLM |
| Isolation | V8 isolate (par deployment) | MicroVM Linux (hardened) |
| Secrets | Credentials materialization (ADR-003) | Aucun, jamais |
| Réseau | Broker seulement | Broker seulement (allowlist) |
| API CRUD | Oui (créer/détruire des agents) | Oui (créer/détruire des instances) |

## Justification

- **Séparation orchestration / exécution** — l'agent qui gère l'état ne devrait jamais exécuter du code arbitraire
- **Long-running + éphémère** — l'agent vit en permanence (Subhosting), l'exécution est ponctuelle (Sandbox 30 min max)
- **KV propre** — chaque agent Subhosting a son KV isolé pour mémoire et sessions
- **Permissions hardened** — le code s'exécute dans la couche la plus sécurisée (microVM), pas dans l'agent
- **Un seul modèle** — pas de distinction "code de confiance" vs "code non fiable", tout passe par la Sandbox
- **Coût maîtrisé** — Subhosting inclus dans Deploy, Sandbox facturé uniquement pendant l'exécution

## Conséquences

- Le runtime agent dans Subhosting est léger : réception de messages, appels broker, dispatch vers Sandbox
- Chaque exécution de code crée une instance Sandbox → latence de boot (~1s) à chaque tool call
- Le broker gère le cycle de vie des deux couches : Subhosting (CRUD agents) et Sandbox (CRUD exécutions)
- Les Sandboxes ne conservent rien — tout résultat doit remonter au Subhosting via le broker pour être persisté en KV
