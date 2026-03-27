# ADR-004 : Zéro secret statique — GCP Secret Manager via Deno Deploy OIDC

**Statut :** Accepté (optionnel — env vars Deploy suffisent pour commencer)
**Date :** 2026-03-27

## Contexte

L'ADR-003 concluait que les clés API LLM (Anthropic, OpenAI, etc.) étaient le
**seul secret statique** de l'architecture, stocké en env vars chiffrées sur
Deno Deploy. Tout le reste utilisait OIDC ou credentials materialization.

Or, Deno Deploy est un **OIDC provider natif**. Il peut émettre des tokens OIDC
éphémères qui prouvent l'identité de l'app (organisation, projet, contexte). Ces
tokens peuvent être échangés contre des credentials GCP via Workload Identity
Federation.

## Décision

**Stocker les clés API LLM dans GCP Secret Manager.** Le broker les récupère via
OIDC au runtime — aucun secret statique nulle part.

## Flux

```
Broker (Deno Deploy)                    GCP
     │                                    │
     │  @deno/oidc                        │
     │  → token OIDC éphémère             │
     │  "je suis denoclaw-broker,         │
     │   org xyz, sur Deploy"             │
     │                                    │
     ├──── token OIDC ──────────────────►│
     │                                    │ Workload Identity Federation
     │                                    │ vérifie le token
     │                                    │ mappe vers un service account
     │◄──── credentials GCP temporaires ──┤
     │                                    │
     ├──── Secret Manager API ───────────►│
     │     "donne-moi ANTHROPIC_API_KEY"  │
     │◄──── "sk-ant-..." ────────────────┤
     │                                    │
     │  fetch() vers Anthropic API        │
     │  avec la clé récupérée             │
```

## Configuration GCP — Setup intégré dans la CLI

La commande `denoclaw publish gateway` guide le setup en 3 étapes :

### Étape 1 : Deploy

```bash
deployctl deploy --project=denoclaw-gateway --prod main.ts
```

### Étape 2 : Connexion GCP OIDC (automatisé)

```bash
deno deploy setup-gcp --org=mon-org --app=denoclaw-gateway
```

Cette commande interactive configure :

- **Workload Identity Pool** — trust Deno Deploy comme OIDC provider
- **Service Account** — avec accès `secretmanager.secretAccessor`
- Puis entrer le Workload Provider ID + Service Account Email dans le dashboard
  Deploy

### Étape 3 : Secrets dans Secret Manager

```bash
# Token d'accès au gateway
echo -n "mon-token" | gcloud secrets versions add DENOCLAW_API_TOKEN --data-file=-

# Clés API LLM
echo -n "sk-ant-..." | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-
echo -n "sk-..."     | gcloud secrets versions add OPENAI_API_KEY --data-file=-
```

Secrets stockés :

- `DENOCLAW_API_TOKEN` — token d'accès au gateway
- `ANTHROPIC_API_KEY` — clé API Anthropic
- `OPENAI_API_KEY` — clé API OpenAI
- etc.

## Résultat : zéro secret statique

| Frontière            | ADR-003 (avant)             | ADR-004 (maintenant)                |
| -------------------- | --------------------------- | ----------------------------------- |
| Sandbox → Broker     | Credentials materialization | Inchangé                            |
| Broker → Sandbox API | `@deno/oidc`                | Inchangé                            |
| Tunnel → Broker      | OIDC éphémère               | Inchangé                            |
| Broker → LLM API     | **Clé statique en env var** | **GCP Secret Manager via OIDC**     |
| VPS CLI auth         | Token CLI local             | Inchangé (auth via tunnel one-shot) |

**Plus aucun secret statique dans toute l'architecture.**

## Justification

- **Zéro secret statique** — même les clés API LLM ne sont plus en env vars
- **Rotation automatique** — changer une clé dans Secret Manager, tous les
  brokers la récupèrent au prochain call
- **Audit trail** — GCP logge chaque accès au Secret Manager
- **Révocation instantanée** — désactiver le service account coupe l'accès à
  tous les secrets
- **Pas de fuite possible** — les clés ne sont jamais dans le code, dans git,
  dans les env vars, ni dans les logs Deploy

## Conséquences

- Dépendance à GCP — le broker a besoin de GCP pour récupérer les clés
  (mitigation : cache en mémoire avec TTL)
- Latence au démarrage — premier call au Secret Manager au boot du broker
  (~100ms)
- Configuration initiale — il faut setup le Workload Identity Pool + Service
  Account + Secrets (one-time)
- Le broker peut cacher les clés en mémoire avec un TTL (ex: 1h) pour éviter un
  call Secret Manager à chaque requête LLM

## Mode dégradé

Si GCP est down ou non configuré, le broker peut fallback sur les env vars
Deploy classiques. L'OIDC + Secret Manager est le mode production recommandé,
pas une obligation.
