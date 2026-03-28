# ADR-011 : A2A comme contrat canonique interne et externe

**Statut :** Accepté **Date :** 2026-03-28

## Contexte

Le dépôt a déjà la bonne intuition architecturale :

- **A2A** décrit le travail entre agents
- le **worker protocol** coordonne le runtime local
- **KV** persiste l'état et les traces

Le problème restant est plus subtil : plusieurs chemins broker↔agent et worker↔broker transportent encore des enveloppes custom qui ressemblent à un second modèle de tâche. Cela crée deux récits concurrents pour le même système :

1. un récit A2A pour le réseau et la documentation
2. un récit custom broker/worker pour l'exécution locale

Cette ambiguïté complique les invariants de lifecycle, la gestion des pauses humaines, la traçabilité et les migrations de transport.

## Décision

**A2A devient le contrat canonique unique pour toute représentation du travail agentique, en interne comme en externe.**

Concrètement :

- le **task intent** appartient à A2A
- le **task lifecycle** appartient à A2A
- les **artifacts** appartiennent à A2A
- la **continuation** et la **cancellation** appartiennent à A2A
- les **pauses sur entrée humaine** appartiennent au lifecycle A2A

Le **worker protocol** est conservé, mais réduit strictement aux préoccupations d'infrastructure et de runtime :

- `init`
- `ready`
- `shutdown`
- transport des demandes d'approbation / reprise
- coordination d'exécution bas niveau
- hooks d'observabilité éventuellement nécessaires

Il ne constitue plus un second contrat de tâche.

## Règles normatives

### 1. Un seul modèle de tâche

Toute unité de travail agentique doit pouvoir être décrite par une tâche A2A, qu'elle soit exécutée :

- localement via `postMessage`
- à distance via HTTP
- en streaming via SSE

Le transport peut varier. La sémantique de tâche, non.

### 2. Même lifecycle en local et sur le réseau

Les transitions canoniques vivent dans le modèle A2A, pas dans une enveloppe locale spécifique.

La phrase à conserver partout est :

> **A2A over transport X, persisted in KV, correlated by task/context ids.**

Exemples :

- **Local** : A2A over `postMessage`, persisted in KV, correlated by task/context ids.
- **Deploy** : A2A over HTTP + SSE, persisted in KV, correlated by task/context ids.

### 3. Les pauses humaines sont visibles dans l'état canonique

Les approbations, confirmations et clarifications peuvent être transportées par le worker protocol, mais leur effet doit toujours être visible dans l'état A2A :

- `INPUT_REQUIRED` quand une entrée humaine est attendue
- `WORKING` lors de la reprise
- `REJECTED` quand le refus relève d'un refus humain ou d'une décision de policy, et non d'une panne d'exécution

Le type d'entrée attendue doit être représenté dans des métadonnées structurées et lisibles machine.

### 4. KV est du stockage durable, pas un transport magique

Deno KV reste la couche durable pour :

- état de tâche
- historique
- artifacts
- traces
- corrélation
- idempotence
- checkpoints et leases si nécessaire

**KV Queue n'est pas le modèle canonique broker↔agent.** S'il existe, ce n'est qu'un détail d'implémentation local ou interne au broker.

### 5. Le modèle mental n'est plus RPC-centrique

Le système doit se penser en opérations de tâche :

- submit task
- stream or poll task
- continue task
- cancel task
- finish in terminal state

Un fast path synchrone reste une optimisation, pas le contrat central.

## Comparatif des responsabilités

| Sujet | Canonique | Notes |
| --- | --- | --- |
| canonical task contract | **A2A Task / Message / Artifact lifecycle** | Source unique de vérité pour le travail agentique |
| runtime/infra protocol | **worker protocol interne** | `init`, `ready`, `shutdown`, approval transport, wiring bas niveau |
| storage layer | **Deno KV** | Persistance, traces, idempotence, historique |
| local transport | **`postMessage` / worker bridge** | A2A over transport local, persisted in KV, correlated by task/context ids |
| network transport | **HTTP + SSE** | A2A over transport réseau, persisted in KV, correlated by task/context ids |
| observability correlation ids | **`taskId` + `contextId`** | Corrèlent broker, worker, agent, artifacts et traces |

## Notes d'implémentation

### Approbation atomique TOCTOU-safe

Les grants d'approbation humaine sont scopés à la commande exacte + binaire exact, stockés dans le record `pendingResumes` de la métadonnée broker de la tâche. Chaque grant est consommé atomiquement via `kv.atomic().check().set()` — une seule exécution peut consommer un grant donné. Cela empêche les races entre deux demandes d'approbation simultanées sur la même tâche (le wildcard `"*"` couvre le cas d'un grant global, le grant exact par commande est vérifié en premier).

## Conséquences

### Positives

- une seule histoire cohérente pour le runtime
- invariants de lifecycle centralisés
- pauses humaines visibles dans l'état réel des tâches
- meilleure portabilité entre local et deploy
- migration des transports sans duplication du modèle de tâche

### Négatives / coûts

- il faut garder temporairement des bridges de compatibilité
- certains types/messages internes devront être reclassifiés comme infra-only
- la documentation existante doit être durcie pour ne plus suggérer un contrat parallèle

## Ce que cette ADR n'implique pas

Cette ADR :

- **ne supprime pas** les Workers ou subprocess locaux
- **ne supprime pas** le worker protocol
- **n'impose pas** d'exposer du JSON-RPC brut à tous les callsites internes
- **ne retire pas** KV de la persistance

Elle impose seulement une frontière stricte :

- **A2A = contrat de tâche**
- **worker protocol = plomberie runtime**
- **KV = stockage durable**

## Statut de migration

Jusqu'à suppression complète des bridges temporaires, tout message interne qui ressemble à une tâche doit être évalué selon une question simple :

> Est-ce de la sémantique de travail agentique ? Si oui, cela appartient à A2A.

Si la réponse est non, cela peut rester dans le worker protocol comme détail de runtime.
