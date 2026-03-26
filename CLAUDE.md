# CLAUDE.md — DenoClaw

## Projet

DenoClaw est un agent AI Deno-natif inspiré de nano-claw/PicoClaw. Zéro dépendance externe (sauf @std/* et @opentelemetry/api). Utilise à fond les APIs Deno : KV, Cron, Serve, WebSocket, Command.

## Architecture

- **Subhosting** = héberge l'agent (long-running, KV propre, orchestration)
- **Sandbox** = exécute le code (éphémère, permissions hardened)
- **Broker** (Deploy) = routeur central (LLM proxy, message router, tunnel hub)
- **Tunnels** = WebSocket vers machines locales/VPS (CLI providers + outils)
- Voir `docs/architecture-distributed.md` et les ADRs dans `docs/`

## Pattern AX (Agent Experience)

Source : https://casys.ai/blog/from-dx-to-ax

Toute interface (tools, erreurs, config, broker API) doit être conçue pour des agents, pas juste des humains. Les principes :

### 1. Pas de verb overlap
- Une action = un nom unique + enum explicite
- Pas de `deploy` vs `publish` vs `release` → un seul verbe + `target: enum["staging", "prod"]`

### 2. Safe defaults
- `dry_run: true` par défaut sur toute opération d'écriture
- Opt-in explicite pour les écritures destructives
- Jamais d'action irréversible par défaut

### 3. Structured errors
- Pas de `throw new Error("something went wrong")`
- Toute erreur doit avoir : `code` (enum), `context` (données), `recovery` (quoi faire)
```typescript
{
  code: "TOOL_DENIED",
  context: { tool: "shell", command: "rm -rf /" },
  recovery: "Use an allowed command or update config.tools.deniedCommands"
}
```

### 4. Structured outputs
- Retours machine-readable : `{ status, data, metadata }`
- Pas de logs console comme seul feedback
- Pas de spinners ou progress bars textuels

### 5. Boucle d'exécution Plan → Scope → Act → Verify → Recover
- **Plan** : objectifs et contraintes explicites
- **Scope** : exposer uniquement les outils pertinents
- **Act** : opérations minimales et safe
- **Verify** : critères de succès explicites
- **Recover** : retry / rollback / escalade structurés

### Règle d'or
> "Reliability comes not from better prompts, but from better execution interfaces."

## Conventions de code

- **Deno 2.7.5** — TypeScript strict, pas de Node.js
- **Imports** : via import map dans `deno.json`, pas de `npm:` ou `jsr:` inline
- **Tests** : colocalisés (`foo.ts` → `foo_test.ts` dans le même dossier)
- **Erreurs** : structurées (code + context + recovery), jamais des strings
- **Enums** : au lieu de strings libres pour les valeurs connues
- **Pas de fallback silencieux** — si une opération échoue, l'erreur remonte avec un recovery path
- `deno lint` + `deno fmt` + `deno check` doivent passer à tout moment

## Commandes

```bash
deno task dev       # Dev avec watch
deno task start     # Lancer l'agent
deno task gateway   # Lancer le gateway multi-canal
deno task test      # Tests
deno task check     # Type-check
deno task lint      # Lint
deno task fmt       # Format
```
