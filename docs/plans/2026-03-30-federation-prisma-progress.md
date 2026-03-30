# Suivi d'avancement federation + Prisma

_Date: 2026-03-30_

## References

- [Plan federation broker↔broker via tunnels Deno Deploy](./2026-03-29-federation-tunnels-brokers.md)
- [Plan Prisma Postgres Analytics + Dashboard Integration](./2026-03-29-prisma-postgres-analytics.md)

## Done

- Contrat federation de base introduit avec `types.ts`, `ports.ts` et
  `FederationService`.
- Control-plane federation ajoute sans casser le contrat A2A de taches.
- Identite broker durable et rotation/revocation de session en place.
- Catalogues distants signes avec verification asymetrique cote recepteur.
- Policy bilaterale `allowedAgents` appliquee local + remote.
- Hash canonique Unicode-safe pour l'idempotence cross-broker.
- Reservation atomique KV du `submission record` pour eviter les doublons sous
  concurrence.
- Dead-letter sans duplication au replay d'une soumission deja terminale.
- Validation stricte des TTL de session invalides.
- Dashboard federation degrade proprement en `unavailable` quand les stats sont
  indisponibles.
- KPI dashboard renomme en `Worst Link P95` pour refleter la metrique reelle.
- Correlation federation standardisee puis durcie:
  `taskId`, `contextId`, `linkId`, `remoteBrokerId`, `traceId`.
- Propagation de la derniere trace federation dans `overview`, `network`,
  `activity` et `tunnels`.
- Refus `policy/auth` exposes dans les stats federation et surfacés dans le
  dashboard, avec detail par lien.
- Statistiques federation servies via des agregats KV maintenus a l'ecriture,
  sans rescanner tous les evenements au read-path.
- Tests cibles federation/broker alignes et verts sur les flux modifies.

## Partially Done

- KV couvre bien le temps reel et le backlog resilience, mais pas encore
  l'analytics historique SQL prevu par Prisma/Postgres.

## Remaining

- Ajouter un endpoint ou une vue d'inspection/replay du dead-letter backlog
  pour l'operabilite.
- Demarrer le plan Prisma/Postgres analytics:
  `prisma/schema.prisma`, `src/db/client.ts`, `docker-compose.yml`, hooks
  d'ecriture et endpoints `/api/stats/*`.
- Ajouter les tests de contrat/integration encore absents:
  `src/orchestration/federation/types_test.ts`,
  `src/orchestration/federation/ports_test.ts`,
  `src/orchestration/federation/tunnel_integration_test.ts`.

## Recommended Order

1. Ajouter l'inspection/replay du dead-letter backlog.
2. Lancer Prisma/Postgres pour l'historique et les analytics dashboard.
3. Completer les tests de contrat et d'integration federation.

## Notes

- Prisma aidera surtout pour l'analytics historique et les requetes dashboard
  riches. Il ne remplace pas le besoin immediat de garder des agregats temps
  reel efficaces cote federation.
- Le contrat de correlation federation est maintenant assez strict pour servir
  de base stable a la suite du chantier.
