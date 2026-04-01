# CLI Rationalization — Plug In / Plug Off

## Principe

Deux modes : **local** (dev) et **en ligne** (prod). On travaille en local, on
publie quand c'est prêt. Chaque commande est interactive par défaut,
AX-compatible via flags (`--json`, `--yes`).

## Commandes principales

| Commande                   | Rôle                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `denoclaw dev`             | Travailler en local (gateway + agents + dashboard)                      |
| `denoclaw deploy`          | Déployer/mettre à jour le broker en ligne (1ère fois = create + config) |
| `denoclaw publish [agent]` | Pousser un agent vers le broker en ligne                                |
| `denoclaw status`          | État local + en ligne                                                   |

## Commandes secondaires

| Commande                            | Rôle                         |
| ----------------------------------- | ---------------------------- |
| `denoclaw init`                     | Wizard première config       |
| `denoclaw agent create/list/delete` | Gestion agents locaux        |
| `denoclaw tunnel [url]`             | Connecter un tunnel (avancé) |
| `denoclaw logs`                     | Logs du broker en ligne      |

## Fusions / suppressions

- `start` (REPL) → `dev --agent <id>` pour mode REPL
- `gateway` → `dev`
- `broker` → `deploy` (en ligne) / `dev` (en local)
- `publish agent` → `publish`
- `setup provider/channel/agent` → `init` (tout en un)
- `sync-agents` → intégré dans `deploy` / `publish`

## AX Compatibility

- `--json` : sortie JSON structurée
- `--yes` : skip confirmations
- Non-TTY auto-détecté → mode non-interactif
- Erreurs = JSON `{ "error", "code" }` en mode `--json`
