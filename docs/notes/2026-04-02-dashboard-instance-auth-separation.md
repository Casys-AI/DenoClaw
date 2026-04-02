# Dashboard : séparer auth et gestion d'instances

## Problème

Le login dashboard mélange deux concerns :
- **Auth** (qui es-tu ?) : token bearer ou GitHub OAuth
- **Config d'instances** (quoi monitorer ?) : URL(s) des brokers/gateways

En mode `token`, le formulaire de login demande UNE url + UN token.
Résultat : impossible de monitorer plusieurs instances (ex: cloud + tunnel local).

Le multi-instance ne marche qu'en mode `local-open` via `DENOCLAW_BROKER_URLS`,
ce qui crée deux flows complètement différents selon le contexte.

## Comportement actuel

| Mode | Auth | Instances | Multi-instance |
|------|------|-----------|----------------|
| `local-open` | aucune | env vars (`DENOCLAW_BROKER_URLS`) | oui |
| `token` | formulaire login | cookie unique | non |
| `github-oauth` | GitHub SSO | env vars | oui |

## Design cible

- Le login gère **uniquement l'auth** (token ou GitHub OAuth)
- Les instances se gèrent **depuis le dashboard** après login
- Bouton "Add instance" qui persiste en cookie ou KV
- Même flow partout : local, déployé, une ou plusieurs instances

## Aussi

- Le broker n'exposait pas `/agents/status` (seulement le gateway) — corrigé dans `broker/http_routes.ts`
- Le dashboard appelait `/agents` et `/cron` au lieu de `/agents/status` et `/cron/jobs` — corrigé dans `web/lib/api-client.ts`
- Le proxy `api/agents.ts` appelait `/api/agents` (configs) au lieu de `/agents/status` (runtime) en GET — corrigé
