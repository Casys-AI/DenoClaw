# CLI Rationalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rationaliser le CLI DenoClaw autour d'un workflow par étapes : dev local → deploy → publish, avec compatibilité AX (--json, --yes, TTY detection).

**Architecture:** Refactor de `main.ts` (command switch) + ajout d'un module `src/cli/output.ts` pour la couche AX. Les fonctions existantes dans `src/cli/setup.ts` et `src/cli/agents.ts` sont réutilisées et adaptées. `publishGateway()` est câblé dans la nouvelle commande `deploy`.

**Tech Stack:** Deno, @std/cli, deno deploy CLI

---

### Task 1: Couche output AX-compatible (`src/cli/output.ts`)

**Files:**
- Create: `src/cli/output.ts`
- Modify: `src/cli/prompt.ts`

- [ ] **Step 1: Créer `src/cli/output.ts`**

```typescript
/**
 * AX-compatible output layer.
 * --json → structured JSON, --yes → skip confirmations, non-TTY → auto non-interactive.
 */

export interface CliFlags {
  json: boolean;
  yes: boolean;
  interactive: boolean;
}

let _flags: CliFlags = { json: false, yes: false, interactive: true };

export function initCliFlags(args: { json?: boolean; yes?: boolean }): void {
  const isTTY = Deno.stdin.isTerminal();
  _flags = {
    json: args.json ?? !isTTY,
    yes: args.yes ?? !isTTY,
    interactive: isTTY && !args.json,
  };
}

export function cliFlags(): CliFlags {
  return _flags;
}

/** Output a result — JSON object in AX mode, human text otherwise. */
export function output(data: Record<string, unknown>, humanText?: string): void {
  if (_flags.json) {
    console.log(JSON.stringify(data));
  } else if (humanText) {
    console.log(humanText);
  }
}

/** Output an error — JSON in AX mode, stderr otherwise. */
export function outputError(code: string, message: string): void {
  if (_flags.json) {
    console.log(JSON.stringify({ error: message, code }));
  } else {
    console.error(`✗ ${message}`);
  }
}
```

- [ ] **Step 2: Mettre à jour `src/cli/prompt.ts` pour respecter les flags AX**

Ajouter en haut de `prompt.ts` :

```typescript
import { cliFlags } from "./output.ts";
```

Modifier `confirm()` pour respecter `--yes` :

```typescript
export async function confirm(
  question: string,
  defaultYes = true,
): Promise<boolean> {
  if (cliFlags().yes) return true;
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${suffix}`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}
```

Modifier `ask()` pour erreur en mode non-interactif sans valeur par défaut :

```typescript
export async function ask(
  question: string,
  defaultValue?: string,
): Promise<string> {
  if (!cliFlags().interactive && !defaultValue) {
    throw new Error(`Missing required input: ${question} (non-interactive mode, no default)`);
  }
  if (!cliFlags().interactive) return defaultValue!;

  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  await Deno.stdout.write(encoder.encode(`${question}${suffix}: `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return defaultValue || "";

  const answer = decoder.decode(buf.subarray(0, n)).trim();
  return answer || defaultValue || "";
}
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/output.ts src/cli/prompt.ts
git commit -m "feat(cli): add AX-compatible output layer with --json, --yes, TTY detection"
```

---

### Task 2: Commande `dev` (remplace `gateway` + `agent`)

**Files:**
- Modify: `main.ts`

- [ ] **Step 1: Ajouter le cas `dev` dans le switch de `main.ts`**

La commande `dev` lance le gateway local. Avec `--agent <id>` sans `gateway`, elle lance le mode REPL.

```typescript
case "dev": {
  const config = await getConfig();
  if (args.agent && !args.message) {
    // REPL mode with a specific agent
    await agent(config);
  } else if (args.agent && args.message) {
    // One-shot message
    await agent(config);
  } else {
    // Full gateway mode (default)
    await gateway(config);
  }
  break;
}
```

- [ ] **Step 2: Garder `gateway` et `agent` comme alias (backward compat temporaire)**

Ajouter un log de deprecation dans les anciens cas :

```typescript
case "gateway": {
  console.log("⚠ 'denoclaw gateway' is deprecated. Use 'denoclaw dev' instead.\n");
  const config = await getConfig();
  await gateway(config);
  break;
}
```

Idem pour `case "agent"` sans subcommand, et `case "broker"`.

- [ ] **Step 3: Mettre à jour la task `dev` dans `deno.json`**

Remplacer la task `dev` existante :

```json
"dev": "deno run --watch --unstable-kv --unstable-cron --allow-all --env main.ts dev"
```

- [ ] **Step 4: Commit**

```bash
git add main.ts deno.json
git commit -m "feat(cli): add 'dev' command replacing gateway+agent for local work"
```

---

### Task 3: Commande `deploy` (broker en ligne)

**Files:**
- Modify: `main.ts`
- Modify: `src/cli/setup.ts` (refactor `publishGateway` pour utiliser `deno deploy` au lieu de `deployctl`)

- [ ] **Step 1: Refactorer `publishGateway()` → `deployBroker()` dans `src/cli/setup.ts`**

Remplacer l'implémentation `deployctl` par `deno deploy` :

```typescript
export async function deployBroker(opts?: {
  org?: string;
  app?: string;
  prod?: boolean;
}): Promise<void> {
  const config = await getConfigOrDefault();
  const interactive = cliFlags().interactive;

  // 1. Determine org and app
  const org = opts?.org || (interactive
    ? await ask("Deploy org", config.deploy?.org || "casys")
    : config.deploy?.org);
  const app = opts?.app || (interactive
    ? await ask("Deploy app name", config.deploy?.app || "denoclaw")
    : config.deploy?.app);

  if (!org || !app) {
    outputError("MISSING_ORG_APP", "Organization and app name are required. Use --org and --app.");
    return;
  }

  // 2. Check if app exists, create if needed
  print(`\nChecking app ${app} on org ${org}...`);
  const checkCmd = new Deno.Command("deno", {
    args: ["deploy", "logs", "--org", org, "--app", app, "--limit", "1"],
    stdout: "piped",
    stderr: "piped",
  });
  const checkResult = await checkCmd.output();

  if (!checkResult.success) {
    print("App not found. Creating...");
    const createCmd = new Deno.Command("deno", {
      args: ["deploy", "create", "--org", org, "--app", app],
      stdout: "inherit",
      stderr: "inherit",
    });
    const createResult = await createCmd.output();
    if (!createResult.success) {
      outputError("CREATE_FAILED", "Failed to create app on Deno Deploy.");
      return;
    }
    success(`App ${app} created on org ${org}`);
  } else {
    print(`App ${app} exists.`);
  }

  // 3. Sync env vars (LLM keys from local config)
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    ollama: "OLLAMA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: "GEMINI_API_KEY",
  };

  for (const [name, cfg] of Object.entries(config.providers)) {
    if (cfg?.apiKey && envMap[name]) {
      print(`Setting ${envMap[name]}...`);
      const envCmd = new Deno.Command("deno", {
        args: ["deploy", "env", "add", "--org", org, "--app", app, `${envMap[name]}=${cfg.apiKey}`],
        stdout: "piped",
        stderr: "piped",
      });
      await envCmd.output();
    }
  }

  // Ensure DENOCLAW_API_TOKEN is set
  let apiToken = Deno.env.get("DENOCLAW_API_TOKEN");
  if (!apiToken) {
    apiToken = crypto.randomUUID();
    print(`Setting DENOCLAW_API_TOKEN...`);
    const tokenCmd = new Deno.Command("deno", {
      args: ["deploy", "env", "add", "--org", org, "--app", app, `DENOCLAW_API_TOKEN=${apiToken}`],
      stdout: "piped",
      stderr: "piped",
    });
    await tokenCmd.output();
  }

  // 4. Deploy
  print("\nDeploying...");
  const deployArgs = ["deploy", "--org", org, "--app", app];
  if (opts?.prod !== false) deployArgs.push("--prod");

  const deployCmd = new Deno.Command("deno", {
    args: deployArgs,
    stdout: "inherit",
    stderr: "inherit",
  });
  const deployResult = await deployCmd.output();

  if (!deployResult.success) {
    outputError("DEPLOY_FAILED", "Deployment failed.");
    return;
  }

  // 5. Save deploy config locally for future use
  config.deploy = { org, app };
  await saveConfig(config);

  const url = `https://${app}.deno.dev`;
  output(
    { success: true, url, org, app, apiToken },
    `\n✓ Broker deployed to ${url}\n\n  API token: ${apiToken}\n  Test: curl -H "Authorization: Bearer ${apiToken}" ${url}/health\n`,
  );
}
```

- [ ] **Step 2: Câbler `deploy` dans `main.ts`**

```typescript
case "deploy": {
  const subCmd = args._[1] as string | undefined;
  if (subCmd === "agent") {
    // backward compat: denoclaw deploy agent → denoclaw publish
    await publishAgent();
  } else {
    await deployBroker({
      org: args.org as string | undefined,
      app: args.app as string | undefined,
      prod: true,
    });
  }
  break;
}
```

Ajouter `"org"` et `"app"` aux string args de `parseArgs`.

- [ ] **Step 3: Ajouter task `deploy` dans `deno.json`**

```json
"deploy": "deno run --unstable-kv --unstable-cron --allow-all --env main.ts deploy"
```

- [ ] **Step 4: Commit**

```bash
git add main.ts src/cli/setup.ts deno.json
git commit -m "feat(cli): add 'deploy' command for one-step broker deployment to Deno Deploy"
```

---

### Task 4: Commande `publish` (push agent vers broker)

**Files:**
- Modify: `main.ts`
- Create: `src/cli/publish.ts`

- [ ] **Step 1: Créer `src/cli/publish.ts`**

```typescript
import { getConfigOrDefault, saveConfig } from "../config/mod.ts";
import { WorkspaceLoader } from "../agent/workspace.ts";
import { ask, confirm, print, success, error } from "./prompt.ts";
import { cliFlags, output, outputError } from "./output.ts";

/**
 * Publish one or all agents to the remote broker.
 * Uses the /api/agents endpoint (same as sync-agents script).
 */
export async function publishAgents(agentName?: string): Promise<void> {
  const config = await getConfigOrDefault();
  const brokerUrl = config.deploy?.app
    ? `https://${config.deploy.app}.deno.dev`
    : undefined;
  const apiToken = Deno.env.get("DENOCLAW_API_TOKEN");

  if (!brokerUrl) {
    outputError("NO_BROKER", "No broker deployed. Run 'denoclaw deploy' first.");
    return;
  }
  if (!apiToken) {
    outputError("NO_TOKEN", "DENOCLAW_API_TOKEN not set. Set it in .env or environment.");
    return;
  }

  // Build list of agents to publish
  const wsRegistry = await WorkspaceLoader.buildRegistry();
  let agentsToPublish: [string, unknown][];

  if (agentName) {
    const entry = wsRegistry[agentName];
    if (!entry) {
      outputError("AGENT_NOT_FOUND", `Agent "${agentName}" not found in workspace.`);
      return;
    }
    agentsToPublish = [[agentName, entry]];
  } else {
    agentsToPublish = Object.entries(wsRegistry);
    if (agentsToPublish.length === 0) {
      outputError("NO_AGENTS", "No agents in workspace.");
      return;
    }
    print(`Found ${agentsToPublish.length} agent(s): ${agentsToPublish.map(([n]) => n).join(", ")}`);
    if (!await confirm("Publish all?")) return;
  }

  const headers = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const [id, entry] of agentsToPublish) {
    const res = await fetch(`${brokerUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: id, config: entry }),
    });

    if (res.ok) {
      success(`${id} published`);
      results.push({ id, ok: true });
    } else {
      const text = await res.text();
      error(`${id} failed: ${res.status} ${text}`);
      results.push({ id, ok: false, error: text });
    }
  }

  output(
    { published: results.filter((r) => r.ok).length, total: results.length, results },
    `\n✓ ${results.filter((r) => r.ok).length}/${results.length} agent(s) published to ${brokerUrl}`,
  );
}
```

- [ ] **Step 2: Câbler `publish` dans `main.ts`**

```typescript
case "publish": {
  const target = args._[1] as string | undefined;
  await publishAgents(target);
  break;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/publish.ts main.ts
git commit -m "feat(cli): add 'publish' command to push agents to remote broker"
```

---

### Task 5: Commande `status` enrichie + `logs`

**Files:**
- Modify: `src/cli/setup.ts` (`showStatus`)
- Modify: `main.ts`

- [ ] **Step 1: Enrichir `showStatus()` avec l'état du broker distant**

Ajouter à la fin de `showStatus()` dans `src/cli/setup.ts` :

```typescript
  // Remote broker status
  const deploy = config.deploy;
  if (deploy?.app) {
    const brokerUrl = `https://${deploy.app}.deno.dev`;
    const token = Deno.env.get("DENOCLAW_API_TOKEN");
    print(`\n── Remote Broker ──\n`);
    print(`URL          : ${brokerUrl}`);

    if (token) {
      try {
        const res = await fetch(`${brokerUrl}/health`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (res.ok) {
          const health = await res.json();
          print(`Status       : online`);
          print(`Tunnels      : ${health.tunnelCount ?? 0}`);
        } else {
          print(`Status       : error (${res.status})`);
        }
      } catch {
        print(`Status       : unreachable`);
      }
    } else {
      print(`Status       : no token (set DENOCLAW_API_TOKEN)`);
    }
  }

  output({
    providers,
    model: config.agents.defaults.model,
    channels,
    deploy: deploy ?? null,
  });
```

- [ ] **Step 2: Ajouter commande `logs` dans `main.ts`**

```typescript
case "logs": {
  const config = await getConfigOrDefault();
  const deploy = config.deploy;
  if (!deploy?.org || !deploy?.app) {
    console.log("No broker deployed. Run 'denoclaw deploy' first.");
    break;
  }
  const logsCmd = new Deno.Command("deno", {
    args: ["deploy", "logs", "--org", deploy.org, "--app", deploy.app],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const { success: ok } = await logsCmd.output();
  if (!ok) console.error("Failed to stream logs.");
  break;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/setup.ts main.ts
git commit -m "feat(cli): enrich status with remote broker info, add logs command"
```

---

### Task 6: Refactor `main.ts` — flags globaux, help, cleanup

**Files:**
- Modify: `main.ts`

- [ ] **Step 1: Ajouter flags globaux `--json`, `--yes` au `parseArgs`**

```typescript
const args = parseArgs(Deno.args, {
  string: [
    "message", "session", "model", "agent",
    "description", "system-prompt", "permissions", "peers", "accept-from",
    "org", "app",
  ],
  boolean: ["force", "json", "yes"],
  alias: { m: "message", s: "session", a: "agent", y: "yes" },
  default: { session: "default" },
});
```

Initialiser la couche AX juste après :

```typescript
import { initCliFlags } from "./src/cli/output.ts";
initCliFlags({ json: !!args.json, yes: !!args.yes });
```

- [ ] **Step 2: Mettre à jour `help()`**

```typescript
function help(): void {
  console.log(`
DenoClaw — Agent IA Deno-natif

Workflow:
  denoclaw init                 Guided setup (provider + channel + agent)
  denoclaw dev                  Work locally (gateway + agents + dashboard)
  denoclaw deploy               Deploy/update the broker on Deno Deploy
  denoclaw publish [agent]      Push agent(s) to the remote broker
  denoclaw status               Show local + remote status
  denoclaw logs                 Stream broker logs

Agents:
  denoclaw agent list           List all agents
  denoclaw agent create <name>  Create an agent
  denoclaw agent delete <name>  Delete an agent

Advanced:
  denoclaw tunnel [url]         Connect a local tunnel to the broker

Options:
  -m, --message    Send a one-off message (with dev --agent)
  -s, --session    Session ID (default: "default")
  -a, --agent      Target agent
  --model          Override the LLM model
  --org            Deno Deploy organization
  --app            Deno Deploy app name
  --json           Structured JSON output (AX mode)
  --yes, -y        Skip all confirmations
`);
}
```

- [ ] **Step 3: Nettoyer les anciens cas — ajouter deprecation warnings**

Pour `gateway`, `broker`, `setup`, `start` : ajouter un message de deprecation puis exécuter la nouvelle commande correspondante.

- [ ] **Step 4: Mettre à jour les tasks dans `deno.json`**

```json
{
  "dev": "deno run --watch --unstable-kv --unstable-cron --allow-all --env main.ts dev",
  "start": "deno run --unstable-kv --unstable-cron --allow-all --env main.ts dev",
  "deploy": "deno run --unstable-kv --unstable-cron --allow-all --env main.ts deploy",
  "publish": "deno run --unstable-kv --unstable-cron --allow-all --env main.ts publish"
}
```

Garder les tasks test/check/lint/fmt inchangées.

- [ ] **Step 5: Commit**

```bash
git add main.ts deno.json
git commit -m "feat(cli): rationalize commands with global --json/--yes flags and updated help"
```

---

### Task 7: Mettre à jour le comportement par défaut (Deno Deploy + local)

**Files:**
- Modify: `main.ts`

- [ ] **Step 1: Simplifier le cas `undefined` (aucune commande)**

```typescript
case undefined: {
  // On Deno Deploy: auto-start gateway
  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    const config = await getConfigOrDefault();
    await gateway(config);
    break;
  }

  // Locally: show help
  help();
  break;
}
```

- [ ] **Step 2: Commit**

```bash
git add main.ts
git commit -m "feat(cli): show help by default locally, auto-gateway on Deploy"
```

---

### Task 8: Ajouter le champ `deploy` au type Config

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/loader.ts` (si nécessaire pour persister `deploy`)

- [ ] **Step 1: Ajouter `deploy` au type Config**

Vérifier le type Config actuel et ajouter :

```typescript
deploy?: {
  org?: string;
  app?: string;
};
```

- [ ] **Step 2: Commit**

```bash
git add src/config/types.ts
git commit -m "feat(config): add deploy field for org/app persistence"
```
