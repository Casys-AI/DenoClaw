# ADR-003 : Auth — OIDC + Credentials Materialization partout où possible

**Statut :** Accepté
**Date :** 2026-03-26

## Contexte

L'architecture DenoClaw a plusieurs frontières d'authentification :
- Broker → API Deno Sandbox (gestion du cycle de vie des agents)
- Broker → API LLM (Anthropic, OpenAI, etc.)
- Tunnel → Broker (machines locales / VPS qui se connectent)
- Sandbox agent → Broker (l'agent communique avec le broker)

L'objectif : minimiser les secrets statiques. Chaque secret statique est un risque (fuite, rotation oubliée, accès non révocable).

## Décision

Utiliser **@deno/oidc** et **credentials materialization** partout où c'est techniquement possible. Les secrets statiques sont un dernier recours.

## Application par frontière

### Broker → API Deno Sandbox : `@deno/oidc`

Le broker tourne sur Deno Deploy. Il utilise `@deno/oidc` pour s'authentifier auprès de l'API Sandbox sans token statique. Le token OIDC prouve l'identité de l'app Deploy, est éphémère et automatiquement renouvelé.

- Élimine : `DENO_SANDBOX_API_TOKEN`
- Le broker n'a pas besoin de stocker ce secret

### Tunnel ↔ Broker : OIDC token éphémère

Quand un tunnel se connecte au broker :
1. Le tunnel s'identifie auprès du broker
2. Le broker vérifie l'identité via OIDC (si le tunnel est aussi sur Deploy) ou via un challenge/response
3. Le broker émet un token éphémère pour la session WebSocket
4. Pas de secret partagé statique entre le tunnel et le broker

Pour les tunnels locaux (pas sur Deploy) : le broker émet un token d'invitation à usage unique. Le tunnel l'utilise pour la connexion initiale, puis reçoit un token de session éphémère.

### Sandbox agent → Broker : Credentials materialization

C'est le cas le plus critique. L'agent dans la Sandbox exécute potentiellement du code non fiable (skills, code LLM-generated). Il doit s'authentifier auprès du broker, mais ne doit JAMAIS voir son propre token.

Avec credentials materialization :
- Le code agent utilise un placeholder : `Bearer {{AGENT_TOKEN}}`
- La plateforme Sandbox injecte la vraie valeur **uniquement** sur les requêtes sortantes vers l'URL du broker
- Le code agent ne peut pas lire, logger ou exfiltrer le token
- Même un code malveillant dans la Sandbox ne peut pas extraire le secret

Couplé au network allowlist (la Sandbox ne peut parler qu'au broker), c'est une double protection.

### Broker → API LLM : Via GCP Secret Manager (voir ADR-004)

Les clés API LLM sont stockées dans **GCP Secret Manager**. Le broker les récupère via OIDC (Deno Deploy est un OIDC provider natif → Workload Identity Federation → Service Account → Secret Manager).

**Plus aucun secret statique dans l'architecture.** Voir ADR-004 pour les détails.

## Résumé

| Frontière | Mécanisme | Secret statique ? |
|---|---|---|
| Broker → Sandbox API | `@deno/oidc` | Non |
| Tunnel → Broker | OIDC éphémère / token d'invitation | Non |
| Sandbox → Broker | Credentials materialization | Non (invisible au code) |
| Broker → LLM API | GCP Secret Manager via OIDC (ADR-004) | **Non** |

## Conséquences

- La surface de secrets statiques est réduite à un seul point : les clés API LLM sur le broker
- Les tokens d'agent sont éphémères et invisibles au code → pas de risque d'exfiltration
- La rotation des tokens est automatique (OIDC) ou gérée par le broker (tokens de session)
- Complexité ajoutée : il faut implémenter le flow OIDC et le flow credentials materialization
- Dépendance : `@deno/oidc` est spécifique à Deno Deploy — si on migre le broker hors Deploy, il faudra un autre mécanisme OIDC
