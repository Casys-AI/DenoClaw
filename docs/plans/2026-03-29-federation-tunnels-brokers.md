# Fédération broker↔broker via tunnels Deno Deploy (plan d’alignement)

_Date: 2026-03-29_

## Position

Oui: avec les tunnels Deno Deploy, DenoClaw a déjà une **base native** crédible pour une fédération entre brokers.
Et oui, il faut être explicite sur ce point: le tunnel est un **mécanisme infra Deno Deploy** (transport), pas une entité métier du domaine fédération.

Le dépôt a déjà les briques clefs:

- un protocole de tunnel versionné (`denoclaw.tunnel.v1`) avec négociation stricte du subprotocol et auth par `Authorization: Bearer ...`;
- un enregistrement explicite des capacités (`tunnelType`, `tools`, `agents`, `allowedAgents`);
- une séparation forte entre contrat de tâche (A2A) et plomberie runtime broker.

La vraie différence avec un "openclaw" plus générique: ici la fédération peut rester **cohérente avec l’architecture A2A canonique**, au lieu d’ajouter un second contrat implicite.

## Règle structurante (très importante)

Le tunnel ne doit jamais dicter le modèle métier:

- **Tunnel Deno Deploy** = adapter de transport (WebSocket, auth, session, reconnect, backpressure).
- **Task Plane A2A** = contrat canonique du travail agent.
- **Federation Control Plane** = entités, ports et méthodes de fédération.

Autrement dit: si demain le transport change (ou s’ajoute), les ports/méthodes/entités de fédération ne bougent pas.

## Ce qu’il faut verrouiller pour que ça marche "proprement"

## 1) Cohérence des entités (DDD léger)

Stabiliser 4 entités explicitement dans le domaine fédération:

1. **BrokerIdentity**
   - `brokerId`, `instanceUrl`, `publicKeys` (ou équivalent trust anchor), `status`.
2. **FederationLink**
   - `linkId`, `localBrokerId`, `remoteBrokerId`, `state`, `lastHeartbeatAt`, `latencyMs`.
3. **RemoteAgentCatalog**
   - `remoteBrokerId`, `agentId`, `card`, `capabilities`, `visibility`.
4. **FederatedRoutePolicy**
   - règles de routage: préférences coût/latence, allow/deny list d’agents, fallback.

Objectif: éviter que `TunnelCapabilities` devienne un fourre-tout runtime + métier.
`TunnelCapabilities` doit rester au niveau infra adapter, puis être traduit vers des entités de domaine stables.

## 2) Ports et adapters (hexagonal)

Définir des **ports applicatifs** (interfaces) et garder le WebSocket en adapter:

- `FederationControlPort`
  - `establishLink()`, `terminateLink()`, `listLinks()`, `refreshTrust()`.
- `FederationDiscoveryPort`
  - `syncRemoteAgents()`, `getRemoteAgentCard(agentId)`.
- `FederationRoutingPort`
  - `resolveTarget(task) -> local|remote`, `forwardTask(task, remoteBrokerId)`.
- `FederationObservabilityPort`
  - `recordCrossBrokerHop()`, `streamFederationEvents()`.

Bénéfice: tu peux faire évoluer transport (WS Deno Deploy aujourd’hui, autre demain) sans toucher la logique métier.

## 3) Méthodes / API contract (simple, stable)

Conserver la règle ADR-011: le travail agent reste en `task_submit`, `task_continue`, `task_get`, `task_cancel`, `task_result`.

Ajouter seulement des méthodes **control-plane** dédiées à la fédération (pas des variantes de task):

- `federation_link_open`
- `federation_link_ack`
- `federation_catalog_sync`
- `federation_route_probe`
- `federation_link_close`

Ces méthodes ne transportent jamais de sémantique métier de tâche: elles servent à la santé du lien, discovery et routage.
Elles sont portées par le control-plane, puis mappées sur le tunnel côté adapter.

## 4) Sécurité inter-brokers (minimum viable sérieux)

- Remplacer progressivement la confiance pure "token d’invite" par une identité broker durable.
- Introduire une rotation de session courte + révocation explicite par lien.
- Signer les annonces de catalogues d’agents (anti-spoof inter-instance).
- Appliquer une policy `allowedAgents` bilatérale (local **et** remote), pas unilatérale.

## 5) Routage et résilience

Pour chaque tâche fédérée, imposer:

- `contextId` + `taskId` globaux et stables;
- idempotency key sur `task_submit` cross-broker;
- retry borné + backoff;
- dead-letter logique (KV) si remote indisponible;
- retour explicite de l’état `INPUT_REQUIRED`/`REJECTED` sans "traduction" locale.

## 6) Observabilité obligatoire

Le projet dispose déjà d’un dashboard: l’objectif est de **l’étendre**, pas de le remplacer.

Minimum dashboard pour fédération:

- taux de succès par lien broker↔broker;
- P50/P95 latence hop fédéré;
- volume `task_submit` local vs fédéré;
- erreurs d’autorisation (`allowedAgents`, auth, policy);
- correlation logs par `taskId` + `contextId` + `remoteBrokerId`.

Sans ça, la fédération devient impossible à opérer.

## 7) Plan de rollout concret

1. **Phase A (contrat)**
   - extraire les ports fédération + types d’entités.
2. **Phase B (transport adapter)**
   - mapper le tunnel WS actuel sur ces ports sans changer A2A task contract.
3. **Phase C (sécurité)**
   - identité broker durable + rotation session + révocation.
4. **Phase D (routage)**
   - policy de sélection local/remote + idempotence + retry.
5. **Phase E (ops)**
   - métriques + alertes + tests chaos simples (link drop / high latency).

## 8) Backlog exécutable (ordre recommandé)

### Epic 1 — Contrat de domaine fédération (entités + ports)

1. Créer `src/orchestration/federation/types.ts`
   - ajouter `BrokerIdentity`, `FederationLink`, `RemoteAgentCatalogEntry`, `FederatedRoutePolicy`.
   - **DoD:** zéro dépendance WebSocket dans ces types.
2. Créer `src/orchestration/federation/ports.ts`
   - définir `FederationControlPort`, `FederationDiscoveryPort`, `FederationRoutingPort`, `FederationObservabilityPort`.
   - **DoD:** signatures orientées métier (pas de `Request`, pas de `WebSocket`).
3. Ajouter tests unitaires de contrat
   - `src/orchestration/federation/types_test.ts`, `ports_test.ts`.
   - **DoD:** validation de schémas, invariants minimaux (`brokerId`, `linkId`, states autorisés).

### Epic 2 — Adapter tunnel Deno Deploy vers les ports

4. Créer `src/orchestration/federation/adapters/tunnel_adapter.ts`
   - mapper register/session/reconnect/backpressure vers `FederationControlPort`.
   - traduire `TunnelCapabilities` -> `RemoteAgentCatalogEntry`.
   - **DoD:** aucune logique métier de routage dans l’adapter.
5. Introduire `FederationService` applicatif
   - `src/orchestration/federation/service.ts`.
   - orchestre ports + policies (sans code WS direct).
   - **DoD:** service testable en mémoire avec faux adapters.
6. Tests d’intégration broker+tunnel
   - `src/orchestration/federation/tunnel_integration_test.ts`.
   - **DoD:** lien ouvert/fermé + sync catalogue + gestion d’erreur auth.

### Epic 3 — Méthodes control-plane (sans casser A2A)

7. Ajouter messages control-plane versionnés
   - `federation_link_open`, `federation_link_ack`, `federation_catalog_sync`, `federation_route_probe`, `federation_link_close`.
   - **DoD:** namespace dédié, séparé des `task_*`.
8. Ajouter une table de mapping “méthode -> handler”
   - pas de `switch` diffus entre fichiers.
   - **DoD:** un point d’entrée control-plane maintenable.
9. Tests de compatibilité
   - vérifier que les flux A2A `task_submit|continue|get|cancel|result` restent inchangés.
   - **DoD:** non-régression explicite ADR-011.

### Epic 4 — Sécurité inter-brokers

10. Introduire identité broker durable
    - store d’identité + rotation clé/session.
    - **DoD:** invalidation d’un lien compromise sans restart global.
11. Signature du catalogue agent
    - signer côté émetteur, vérifier côté récepteur.
    - **DoD:** rejet des catalogues non signés ou signature invalide.
12. Policy bilatérale `allowedAgents`
    - enforce local + remote.
    - **DoD:** refus explicite et tracé quand policy échoue.

### Epic 5 — Routage, idempotence, résilience

13. Ajouter idempotency cross-broker pour `task_submit`
    - clé (`remoteBrokerId`, `taskId`, hash payload).
    - **DoD:** doublon rejoué => pas de double exécution.
14. Retry borné + backoff + dead-letter
    - stockage KV des messages en échec terminal.
    - **DoD:** visibilité dashboard + reprise manuelle possible.
15. Corrélation stricte
    - log/traces systématiques `taskId`, `contextId`, `remoteBrokerId`, `linkId`.
    - **DoD:** un hop fédéré reconstituable de bout en bout.

### Epic 6 — Observabilité & exploitation

16. Exposer métriques fédération
    - succès/erreur par lien, latence p50/p95, backlog retry/dead-letter.
    - **DoD:** endpoint/stream lisible par dashboard.
17. Étendre le dashboard existant (pas créer un nouveau dashboard)
    - enrichir les vues déjà en place (`overview`, `network`, `tunnels`, `activity`) avec les signaux fédération.
    - ajouter des panneaux/counters: succès par lien, latence p95, erreurs policy/auth, dead-letter backlog.
    - **DoD:** un opérateur identifie un lien dégradé en < 1 min depuis l’UI actuelle.
18. Tests chaos
    - drop WS, latence élevée, token expiré, broker distant indisponible.
    - **DoD:** système dégrade proprement sans corruption d’état.

## 9) Priorisation pratique (2 sprints)

- **Sprint 1 (fondations):** items 1→9.
  - Résultat: architecture propre (entités/ports/méthodes), tunnel branché via adapter, A2A non cassé.
- **Sprint 2 (prod-ready):** items 10→18.
  - Résultat: sécurité, résilience, observabilité et opérabilité réelle.

## Décision recommandée

**Oui, aller vers la fédération native via tunnels** — mais en la traitant comme un sous-domaine "Federation Control Plane" séparé du "Task Plane" A2A.

En une phrase:

> A2A reste le contrat des tâches, le tunnel devient l’adapter de transport, et la fédération ajoute un control-plane explicite (entités, ports, méthodes) autour.

---

## 10) Reprise détaillée à partir de l’item 11

Ci-dessous, une reprise opérationnelle en gardant la cohérence demandée: **entités de domaine stables**, **ports applicatifs explicites**, **méthodes control-plane dédiées**, et **adapters infra isolés**.

### Item 11 — Signature du catalogue agent

**Objectif architecture**
- Garantir l’intégrité + authenticité de `RemoteAgentCatalogEntry` sans coupler le domaine au transport tunnel.

**Entités concernées**
- `BrokerIdentity` (clé publique active, version de clé).
- `RemoteAgentCatalogEntry` (payload fonctionnel, sans détail crypto infra).
- Nouvelle value object proposée: `SignedCatalogEnvelope` (message signé côté adapter/control-plane, jamais exposé aux use-cases métier purs).

**Ports / méthodes**
- `FederationDiscoveryPort.syncRemoteAgents()` reçoit un envelope signé, vérifie puis retourne des entrées de domaine validées.
- `FederationControlPort.refreshTrust()` recharge les clés du broker distant.
- Méthodes control-plane impliquées: `federation_catalog_sync`.

**Implémentation recommandée**
1. Canonicaliser le payload catalogue (ordre stable des champs + version schema).
2. Signer côté émetteur avec clé privée broker.
3. Vérifier côté récepteur avec clé publique issue de `BrokerIdentity`.
4. Rejeter explicitement si signature absente/invalide/clé inconnue.

**DoD renforcé**
- Aucun catalogue non signé n’alimente `RemoteAgentCatalog`.
- Traces avec motifs de rejet (`invalid_signature`, `unknown_key`, `stale_key`).

### Item 12 — Policy bilatérale `allowedAgents`

**Objectif architecture**
- Ne jamais décider le routage fédéré uniquement côté local: validation **locale + distante** obligatoire.

**Entités concernées**
- `FederatedRoutePolicy` (règles locales).
- `RemoteAgentCatalogEntry.visibility` / claims distants.
- Nouvelle value object proposée: `FederationAuthorizationDecision`.

**Ports / méthodes**
- `FederationRoutingPort.resolveTarget(task)` applique policy locale en premier.
- `FederationControlPort` déclenche un `federation_route_probe` pour vérifier l’acceptation distante avant forward final.

**Implémentation recommandée**
1. Évaluer allow/deny local (fail-fast).
2. Probe distant (agent visible + autorisé remote).
3. Construire une décision explicite: `ALLOW | DENY_LOCAL | DENY_REMOTE`.
4. Exposer motif normalisé pour observabilité.

**DoD renforcé**
- Refus tracé des deux côtés (corrélés par `taskId/contextId`).
- Aucun fallback implicite en cas de `DENY_REMOTE`.

### Item 13 — Idempotency cross-broker (`task_submit`)

**Objectif architecture**
- Éviter toute double exécution quand tunnel reconnecte, retry, ou duplicate delivery.

**Entités concernées**
- Nouvelle entité proposée: `FederatedSubmissionRecord`
  - `idempotencyKey`, `remoteBrokerId`, `taskId`, `payloadHash`, `status`, `resultRef`, `createdAt`.

**Ports / méthodes**
- `FederationRoutingPort.forwardTask(task, remoteBrokerId)` devient idempotent.
- Méthodes A2A inchangées (`task_submit`) avec métadonnée d’idempotence ajoutée dans le contexte fédération.

**Implémentation recommandée**
1. Calcul clé: (`remoteBrokerId`, `taskId`, `hash(payload canonique)`).
2. Upsert atomique KV avant envoi.
3. Si clé déjà `COMPLETED`/`IN_FLIGHT`, retourner résultat/référence existant.

**DoD renforcé**
- Rejeu de même `task_submit` => 0 exécution supplémentaire.
- Test de concurrence (2 envois simultanés même clé).

### Item 14 — Retry borné + backoff + dead-letter

**Objectif architecture**
- Rendre l’échec explicite et récupérable, sans boucle infinie ni perte silencieuse.

**Entités concernées**
- Nouvelle entité: `FederationRetryState`
  - `attempt`, `nextAttemptAt`, `lastErrorCode`, `lastErrorAt`.
- Nouvelle entité: `FederationDeadLetter`
  - `messageId`, `taskId`, `remoteBrokerId`, `reason`, `payloadRef`.

**Ports / méthodes**
- `FederationRoutingPort.forwardTask(...)` délègue la stratégie retry à un composant applicatif.
- `FederationObservabilityPort.recordCrossBrokerHop()` inclut état retry/dead-letter.

**Implémentation recommandée**
1. Retry sur erreurs transitoires uniquement (timeout, 5xx, disconnect).
2. Backoff exponentiel borné + jitter.
3. Passage en dead-letter après seuil max configurable.
4. Exposer une commande de replay manuel contrôlé.

**DoD renforcé**
- Backlog dead-letter visible + comptable.
- Reprise manuelle sans corruption d’idempotence.

### Item 15 — Corrélation stricte bout-en-bout

**Objectif architecture**
- Pouvoir reconstituer un hop fédéré de façon déterministe depuis logs + métriques + traces.

**Entités concernées**
- Pas de nouvelle entité métier; standardiser un `CorrelationContext` transverse:
  - `taskId`, `contextId`, `remoteBrokerId`, `linkId`, `traceId`.

**Ports / méthodes**
- Tous les ports fédération prennent/retournent le `CorrelationContext`.
- `FederationObservabilityPort.streamFederationEvents()` publie ces dimensions systématiquement.

**DoD renforcé**
- 100% des événements control-plane et task-plane fédérés possèdent les champs de corrélation.

### Item 16 — Exposer métriques fédération

**Objectif architecture**
- Mesurer la santé des liens et l’efficacité du routage fédéré en continu.

**Métriques minimales**
- `federation_link_success_total{linkId,remoteBrokerId}`
- `federation_link_error_total{linkId,errorType}`
- `federation_hop_latency_ms_bucket`
- `federation_retry_backlog`
- `federation_dead_letter_backlog`

**Ports / méthodes**
- `FederationObservabilityPort.recordCrossBrokerHop()` devient la source de vérité métrique.

**DoD renforcé**
- Export consommable par dashboard existant sans duplication de pipeline.

### Item 17 — Étendre le dashboard existant

**Objectif architecture**
- Rester dans l’UI actuelle (`overview`, `network`, `tunnels`, `activity`) et éviter un silo observabilité.

**Plan UI**
1. `overview`: tuiles succès/erreur, P95, backlog retry/dead-letter.
2. `network`: état de chaque `FederationLink` + latence.
3. `tunnels`: détail session, reconnect, auth/policy failures.
4. `activity`: timeline corrélée par `taskId/contextId`.

**DoD renforcé**
- Un opérateur détecte, qualifie et priorise un incident de lien en moins d’1 minute.

### Item 18 — Tests chaos

**Objectif architecture**
- Vérifier que les invariants métier (idempotence, policy, corrélation) tiennent sous stress transport.

**Scénarios minimaux**
1. Drop WS en milieu de `task_submit` fédéré.
2. Latence injectée + jitter extrême.
3. Expiration token/session pendant sync catalogue.
4. Broker distant indisponible prolongé.

**Invariants attendus**
- Pas de double exécution.
- Pas de bypass policy.
- Passage explicite en retry puis dead-letter.
- Traces corrélées exploitables.

---

### Séquencement proposé (reprise immédiate)

1. **Sécurité d’abord**: 11 → 12.
2. **Fiabilité d’exécution**: 13 → 14 → 15.
3. **Opérations**: 16 → 17.
4. **Validation de robustesse**: 18.

En pratique, cela garde la discipline: **entités stables**, **ports applicatifs**, **méthodes control-plane**, **adapters tunnel remplaçables**.
