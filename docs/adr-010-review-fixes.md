# ADR-010 — Review Fixes

**Date :** 2026-03-27 **Source :** Review croisée 5 agents (code reviewer,
silent failure hunter, type design, test coverage, architecture)

## Issues critiques (à corriger)

### Fix 1 — `ask: "always"` ne se déclenche jamais

**Fichier :** `src/agent/tools/shell.ts` (checkExecPolicy) +
`src/agent/tools/backends/local.ts` (enforceExecPolicy) **Problème :**
`checkExecPolicy` retourne `{ allowed: true }` pour les commandes dans
l'allowlist. `enforceExecPolicy` ne rentre dans le ask flow que si
`check.allowed === false`. Donc `ask: "always"` est silencieusement ignoré pour
les commandes autorisées. **Fix :** Ajouter en fin de `checkExecPolicy` : si
`policy.ask === "always"`, retourner
`{ allowed: false, reason: "always-ask", binary }` pour forcer le passage dans
le ask flow.

### Fix 2 — `allowedCommands: []` = tout passe au lieu de tout bloquer

**Fichier :** `src/agent/tools/shell.ts:54` **Problème :**
`if (allowed.length > 0 && !allowed.includes(binary))` — quand la liste est
vide, la condition est false, tout passe. Le `DEFAULT_EXEC_POLICY` utilise
`allowedCommands: []`, ce qui rend le défaut effectivement permissif. **Fix :**
Changer la condition en `if (!allowed.includes(binary))` — une liste vide = deny
all. Cohérent avec AX #2 Safe Defaults.

### Fix 3 — `initPromise` empoisonné après échec init cloud

**Fichier :** `src/agent/tools/backends/cloud.ts` (ensureInitialized) **Problème
:** Si `init()` throw, `initPromise` pointe vers une Promise rejetée pour
toujours. Tous les appels suivants échouent avec la même erreur. Pas de retry
possible. **Fix :** Clear `initPromise` dans le catch + log error. Ajouter aussi
un cleanup de la VM si `Sandbox.create()` réussit mais `fs.upload()` échoue (VM
orpheline sinon).

### Fix 4 — `askPending` dans le Worker n'a pas de timeout — promise qui hang forever

**Fichier :** `src/agent/worker_entrypoint.ts` (askApproval function) **Problème
:** La Promise n'a qu'un `resolve`, pas de `reject` ni de timeout. Si le
WorkerPool ne renvoie jamais `ask_response`, la Promise hang indéfiniment. Le
Worker est zombie. **Fix :** Ajouter timeout + reject dans `askApproval()`
(symétrique à `sendToAgent` qui a déjà un timeout). Drain `askPending` dans le
handler `shutdown`.

### Fix 5 — `approvalTimeout` timer jamais nettoyé

**Fichier :** `src/agent/tools/backends/local.ts` (enforceExecPolicy,
Promise.race) **Problème :** Quand l'approbation arrive avant le timeout, le
`setTimeout` de `approvalTimeout()` n'est jamais `clearTimeout`. Fuite de timer
par approval request. **Fix :** Utiliser un handle de timer cancellable,
`clearTimeout` dans un `finally` après le `Promise.race`. Aussi : distinguer
timeout vs crash dans le catch (log warn pour timeout, log error pour le reste).

### Fix 6 — Cloud backend n'a pas de timeout sur `sandbox.sh`

**Fichier :** `src/agent/tools/backends/cloud.ts` (execute) **Problème :**
`timeoutSec` est calculé mais jamais utilisé. `sandbox.sh` peut hang
indéfiniment. Le Worker est bloqué, la VM n'est jamais killée. **Fix :**
`Promise.race` entre `sandbox.sh` et un timeout. Le catch existant convertira en
`SANDBOX_EXEC_ERROR`.

### Fix 7 — `close()` cascade cassée si `backend.close()` throw

**Fichier :** `src/agent/tools/registry.ts` (close) **Problème :** Si
`backend.close()` throw (ex: `sandbox.kill()` timeout réseau), l'exception
propage et `memory.close()` dans `loop.ts` n'est jamais appelé. **Fix :**
try/catch dans `registry.close()`, log error, ne jamais propager.

### Fix 8 — `handleAskApproval` async sans await — unhandled rejection

**Fichier :** `src/agent/worker_pool.ts:200-202` **Problème :**
`this.handleAskApproval(fromAgentId, msg)` est async mais le call site n'a ni
`await` ni `.catch()`. Si `postMessage` throw (worker déjà terminé), unhandled
promise rejection → crash potentiel du process. **Fix :** Ajouter
`.catch(e => log.error(...))` au call site.

### Fix 9 — `networkAllow` toujours `undefined` dans `registry.ts:105`

**Fichier :** `src/agent/tools/registry.ts` (execute) **Problème :** Le
`SandboxExecRequest` a `networkAllow: undefined`. La config sandbox a un
`networkAllow` mais il n'est jamais passé au backend. Le subprocess spawn sans
restriction réseau si `net` est dans les permissions. **Fix :** Stocker
`networkAllow` dans `ToolRegistry` via `setBackend()`, le passer dans chaque
`execute()`.

### Fix 10 — `factory.ts` throw `new Error(JSON.stringify(...))` au lieu de `DenoClawError`

**Fichier :** `src/agent/tools/backends/factory.ts:19` **Problème :** Le payload
structuré est sérialisé dans le message d'une `Error` brute. Les callers ne
peuvent pas `.code` ou `.context`. Viole le pattern d'erreur du projet. **Fix
:**
`throw new ToolError("SANDBOX_UNAVAILABLE", { backend: "cloud", reason: "DENO_DEPLOY_TOKEN not set" }, "Set DENO_DEPLOY_TOKEN or use backend: 'local'")`.

---

## Issues design (à discuter)

### Design 1 — `envFilter` dans `ExecPolicy` est du dead code

Le champ est déclaré dans le type mais `filterEnv()` dans shell.ts utilise
hardcoded `DENIED_ENV_PREFIXES`. `policy.envFilter` n'est jamais lu. **Options
:** Wirer `envFilter` → `filterEnv()`, ou supprimer le champ.

### Design 2 — `SandboxExecResult` duplique `ToolResult`

Même shape exacte (`success`, `output`, `error?`). Le cast
`JSON.parse(out) as SandboxExecResult` est un cast silencieux vers un type
identique. **Options :** `type SandboxExecResult = ToolResult`, ou garder séparé
si divergence future prévue.

### Design 3 — `ask_approval.reason` est `string` dans le protocol

`WorkerResponse.ask_approval.reason` est `string`, mais `ApprovalRequest.reason`
est une union typée. Type divergence sur un chemin de sécurité. **Options :**
Aligner le type dans `worker_protocol.ts`.

### Design 4 — Cloud backend ignore `req.execPolicy` entièrement

Un agent avec `security: "deny"` exécute quand même dans le cloud backend. Le
ADR dit "optionnel" mais `security: "deny"` devrait au minimum être honoré.
**Options :** Honorer `security: "deny"` dans cloud, ignorer le reste (la VM
isole).

### Design 5 — Cloud backend `--allow-all` ignore l'intersection ADR-005

Les permissions dans `req.permissions` arrivent mais sont ignorées. Le
subprocess dans la VM tourne avec `--allow-all`. **Options :** Acceptable (la VM
isole), mais documenter explicitement. Ou appliquer les flags dans la VM aussi.

### Design 6 — `filterEnv` strip PATH → les binaires ne sont plus trouvables

Sans PATH, `Deno.Command("git", [...])` ne trouve pas `git`. Les commandes
échouent avec `COMMAND_EXEC_ERROR` sans explication claire. **Options :** Ne pas
strip PATH (strip seulement LD__/DYLD__), ou utiliser un PATH restreint
explicite.

### Design 7 — `ExecPolicy` devrait être une union discriminée

`security: "deny"` avec `allowedCommands: ["git"]` est structurellement valide
mais sémantiquement incohérent. Un type discriminé empêcherait ça. **Options :**
Transformer en union discriminée sur `security`, ou valider à la construction.

### Design 8 — `strictInlineEval` absent = true (inversé)

Le champ est `boolean | undefined` mais le défaut est `true` (vérifié avec
`!== false`). Contre-intuitif. **Options :** Renommer en
`allowInlineEval?: boolean` (absent = false = strict).

### Design 9 — `supportsFullShell` déclaré mais jamais utilisé

Le flag est sur l'interface `SandboxBackend` mais aucun code ne branch dessus.
Décoratif. **Options :** Utiliser pour le routing, ou supprimer.

### Design 10 — `deniedCommands` utilise `string.includes()` → false positives

`command.includes("rm")` matche aussi `echo "rm is dangerous"`. Faux positifs
sur les arguments. **Options :** Matcher sur le binaire (premier mot) plutôt que
la commande entière.
