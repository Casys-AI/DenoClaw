# ADR-009 : Mémoire agents — KV conversations + Markdown long-terme

**Statut :** En cours
**Date :** 2026-03-27
**Dernière mise à jour :** 2026-03-27

## Contexte

La mémoire des agents DenoClaw était un blob unique `Message[]` dans Deno KV. Pas d'indexation, pas de recherche, pas de long-terme, pas d'interface DDD. Le refactoring workspace agents est l'occasion de restructurer la mémoire.

Après exploration approfondie de l'écosystème (kvdex, denodata, kv-toolbox, Serena, OpenClaw, NanoClaw, PicoClaw, Mem0, Zep, Letta, CrewAI), la décision est un **modèle dual** :

- **Court-terme (conversations)** → KV structuré via kvdex
- **Long-terme (connaissances)** → Fichiers Markdown (pattern OpenClaw/Serena/NanoClaw)

## Décision

### Court-terme : kvdex pour les conversations ✅ IMPLÉMENTÉ

kvdex (`@olli/kvdex@^3`) structure les conversations dans le KV privé de chaque agent :
- Collections typées avec index secondaire `sessionId`
- Tri par `seq`, trim à `maxMessages` (garde les system messages)
- Cache in-memory synchrone pour `getMessages()` (hot path du loop)
- Compression/segmentation automatique (dépasse la limite 64KB)
- `MemoryPort` interface DDD — le loop dépend de l'interface, pas du concret

**Pourquoi kvdex et pas raw KV :** les conversations sont des données structurées (session × seq × role) qui bénéficient de l'indexation secondaire et de la compression. kvdex ajoute peu de surface et beaucoup de valeur ici.

### Long-terme : fichiers Markdown ⏳ À IMPLÉMENTER

Chaque agent a un dossier `memories/` dans son workspace :

```
~/.denoclaw/agents/alice/
  agent.json        ← config
  soul.md           ← system prompt
  skills/           ← skills .md
  memory.db         ← KV conversations (kvdex)
  memories/         ← connaissances long-terme (.md)
    project.md
    user_preferences.md
    learned_patterns.md
```

**Tools exposés au LLM** (pattern Serena) :
- `list_memories` — lister les fichiers mémoire disponibles
- `read_memory(file)` — lire un fichier mémoire
- `write_memory(file, content)` — créer/réécrire un fichier mémoire
- `edit_memory(file, search, replace)` — éditer une section
- `delete_memory(file)` — supprimer (décision explicite de l'agent uniquement)

**Au démarrage** : la liste des fichiers mémoire est injectée dans le system prompt pour que l'agent sache ce qu'il a mémorisé.

## Pourquoi ce modèle dual

### Pourquoi KV pour le court-terme

- Les conversations sont des séquences ordonnées de messages — un cas d'usage classique KV
- Le trim (window management) nécessite des opérations atomiques
- Le cache synchrone est nécessaire pour le hot path du loop
- Pas besoin qu'un humain lise les conversations brutes
- Fonctionne sur Deno Deploy (pas de filesystem)

### Pourquoi Markdown pour le long-terme

- **Lisible par l'humain** — tu peux ouvrir `user_preferences.md` et corriger un fact faux
- **Git-friendly** — les memories se diffent, se commitent, se review
- **Consolidation naturelle** — l'agent "résume" en réécrivant un paragraphe, pas besoin de système bi-temporal
- **Pattern éprouvé** — OpenClaw (MEMORY.md + LanceDB), NanoClaw (CLAUDE.md par groupe), Serena (.serena/memories/), Claude Code (memory/)
- **Pas d'éviction automatique** — le long-terme ne s'efface jamais seul, c'est l'agent ou l'humain qui décide
- **Extensible** — on peut ajouter du vector search par-dessus les .md plus tard (embeddings, memsearch, LanceDB)

### Pourquoi pas tout en KV

L'exploration a montré que stocker des connaissances long-terme dans KV pose des problèmes fondamentaux :
- **Opaque** — un `.db` SQLite n'est pas lisible/éditable par l'humain
- **Pas de consolidation naturelle** — il faut inventer un système bi-temporal (FactRecord, status superseded/consolidated, versionstamp CAS) pour ce que le Markdown fait naturellement
- **Croissance non bornée** — sans mécanisme de compaction, les facts s'accumulent. kvdex n'a pas de pruning built-in
- **Pas git-friendly** — impossible de review les connaissances d'un agent dans un PR

### Pourquoi pas tout en Markdown

Les conversations ne sont pas adaptées au format fichier :
- Volume élevé (centaines de messages par session)
- Besoin de trim atomique et de pagination
- Pas besoin de lisibilité humaine pour les messages bruts
- Sur Deno Deploy, pas de filesystem → KV obligatoire

## Options évaluées et rejetées

### denodata

50+ opérateurs de recherche intéressants, mais **projet abandonné** (dernier commit sept 2023, v0.0.28-beta, 15 stars). TTL lazy (cleanup au read seulement). API incompatible Deno 2.x. **Rejeté.**

### kv-toolbox

Blobs > 64KB, chiffrement, batched atomics. **Complémentaire** — peut être ajouté plus tard pour le chiffrement at-rest ou les gros artefacts. Pas nécessaire pour la mémoire conversationnelle ou long-terme.

### Tout en kvdex (long-terme dans KV)

Implémenté puis remis en question. kvdex supporte `expireIn` (TTL natif Deno KV) et `count()`, mais :
- Pas de compaction/consolidation built-in
- Pas de déduplication
- Les facts dans KV sont opaques (pas éditables par l'humain)
- Le pattern n'est utilisé par aucun framework agent sérieux

### Raw KV bi-temporal (FactRecord, versionstamp CAS)

Exploré en profondeur : clés ordonnées `["facts", agentId, topic, timestampMs]`, index actif/par-id/par-tx, consolidation atomique via `kv.atomic().check()`. Techniquement correct mais **sur-engineeré** pour le besoin réel. Un fichier `project.md` que l'agent édite fait le même travail en 10x moins de code.

### Recherche symbolique (SWC / LSP)

Deno a `deno_ast` (parser SWC en Rust), exposé en WASM via `@jsz/swc` et `@deco/deno-ast-wasm` sur JSR. Parse TypeScript/JavaScript uniquement (pas multi-langage comme Serena qui utilise multilspy + 40 LSP). **Pertinent pour un futur tool `code_analyze`**, pas pour la mémoire long-terme. Noté pour plus tard.

## Recherche : patterns mémoire dans l'écosystème

### Frameworks agents — comment ils gèrent la mémoire

| Framework | Court-terme | Long-terme | Recherche | Consolidation |
|---|---|---|---|---|
| **OpenClaw** | Messages en contexte | `MEMORY.md` + `memory/YYYY-MM-DD.md` | LanceDB semantic (memsearch) | Agent auto-écrit avant compaction contexte |
| **NanoClaw** | SQLite messages | `CLAUDE.md` par groupe | — | Agent édite le .md |
| **Serena** | — | `.serena/memories/*.md` | Liste + read | Agent écrit/édite via tools |
| **Letta/MemGPT** | Context window (RAM) | Core blocks + Archival (vector DB) | Embedding search | Recursive summarization + sleep-time agents |
| **CrewAI** | RAG short-term | LanceDB + SQLite | Composite score (semantic × recency × importance) | LLM-assisted dedup (cosine > 0.85) |
| **Mem0** | — | Vector store + knowledge graph | Hybrid vector + graph | LLM-as-router (ADD/UPDATE/DELETE/NOOP) |
| **Zep/Graphiti** | Episodes (raw messages) | Bi-temporal knowledge graph | Vector + BM25 + graph traversal | Edge dedup + community summaries |

### Convergences observées (2025-2026)

1. **Mémoire tiered** — tout le monde sépare court-terme (structuré/DB) et long-terme (documents/fichiers)
2. **Markdown comme source of truth** — OpenClaw, NanoClaw, Serena, Claude Code utilisent tous des .md
3. **Vector search comme couche additionnelle** — ajouté par-dessus les documents, pas comme storage primaire
4. **Pas de hard-delete sur le long-terme** — soft decay (Zep bi-temporal, CrewAI half-life) ou edit explicite
5. **Sleep-time consolidation** — Letta, Google, Claude Code font de la maintenance mémoire en idle
6. **LLM-as-memory-router** — Mem0 pattern (l'agent décide ADD/UPDATE/DELETE) se répand

### Primitives Deno pertinentes pour le futur

| Primitive | Usage potentiel |
|---|---|
| `kv.enqueue()` + `Deno.cron()` | Sleep-time consolidation (background memory maintenance) |
| `kv.watch()` | Cross-agent memory events (max 10 clés, sentinels) |
| `.sum()` / `.max()` (atomics CRDT) | Compteurs de facts sans lock |
| `@jsz/swc` / `@deco/deno-ast-wasm` | Futur tool code_analyze (parse TS AST en WASM) |
| `kv-toolbox` blob + crypto | Futur chiffrement at-rest, artefacts > 64KB |

## État actuel de l'implémentation

### ✅ Fait

- `MemoryPort` interface DDD (`src/agent/memory_port.ts`)
- `KvdexMemory` adapter pour conversations (`src/agent/memory_kvdex.ts`)
- `Memory implements MemoryPort` fallback (`src/agent/memory.ts`)
- `WorkspaceLoader` CRUD workspaces (`src/agent/workspace.ts`)
- `MemoryTool` KV-backed avec 4 actions (`src/agent/tools/memory.ts`)
- Topics injectés dans le system prompt (`src/agent/context.ts`, `loop.ts`)
- CLI workspace-backed (`src/cli/agents.ts`)
- Config merge workspace + registry (`src/config/loader.ts`)
- Helpers `getAgent*()` + `validateAgentId()` (`src/shared/helpers.ts`)
- Runtime unifié avec MemoryPort (`src/agent/runtime.ts`)
- Worker wiring KvdexMemory + ensureDir (`worker_entrypoint.ts`, `worker_pool.ts`)
- 95 tests passent, type-check OK, lint clean

### ⏳ À faire — Mémoire long-terme fichiers .md

1. `WorkspaceLoader.create()` crée `memories/`
2. Réécrire `MemoryTool` : 5 actions fichier (list, read, write, edit, delete) au lieu de 4 actions KV
3. Adapter `MemoryPort` : séparer conversations (KV) et long-terme (fichier) ou créer un `LongTermMemoryPort` séparé
4. Adapter `loop.ts` : lister les .md au lieu des topics kvdex
5. Adapter `context.ts` : injecter la liste des fichiers mémoire dans le prompt
6. Retirer les méthodes `remember/recall/listTopics/forgetTopic` de KvdexMemory (conversations only)
7. Tests du MemoryTool fichier

### 🔮 Futur (hors scope)

- Semantic search sur les .md (embeddings, memsearch, LanceDB)
- Sleep-time consolidation via `Deno.cron()` + `kv.enqueue()`
- Cross-agent memory events via `kv.watch()` sentinels sur shared KV
- Tool `code_analyze` basé sur SWC WASM (`@jsz/swc`)
- Chiffrement mémoire via `kv-toolbox` crypto
- Onboarding auto (Serena pattern — l'agent analyse le projet au premier lancement)

## Conséquences

- La mémoire long-terme est lisible, éditable, et git-friendly
- Le modèle dual (KV + .md) couvre les deux usages sans sur-engineering
- L'architecture est extensible vers le vector search sans refonte
- Compatible local (filesystem) et Deploy (KV conversations toujours, .md via un adapter blob KV si besoin)
