# ADR-005 : Permissions Sandbox — moindre privilège par intersection

**Statut :** Accepté **Date :** 2026-03-27

## Contexte

Quand un agent exécute un outil (shell, file, web), le broker crée une Sandbox
éphémère. La question : quelles permissions donner à cette Sandbox ?

## Décision

**Intersection tool × agent.** Chaque outil déclare les permissions dont il a
besoin. Chaque agent déclare les permissions maximales qu'il autorise. La
Sandbox reçoit l'intersection des deux.

## Permissions disponibles

| Permission | Description                | Deno flag       |
| ---------- | -------------------------- | --------------- |
| `read`     | Lire des fichiers          | `--allow-read`  |
| `write`    | Écrire des fichiers        | `--allow-write` |
| `run`      | Exécuter des commandes     | `--allow-run`   |
| `net`      | Accès réseau               | `--allow-net`   |
| `env`      | Variables d'environnement  | `--allow-env`   |
| `ffi`      | Foreign Function Interface | `--allow-ffi`   |

## Déclaration côté outil (AX : explicite)

Chaque outil déclare ses besoins dans sa définition :

```typescript
class ShellTool extends BaseTool {
  name = "shell";
  permissions: SandboxPermission[] = ["run"];
}

class ReadFileTool extends BaseTool {
  name = "read_file";
  permissions: SandboxPermission[] = ["read"];
}

class WriteFileTool extends BaseTool {
  name = "write_file";
  permissions: SandboxPermission[] = ["write"];
}

class WebFetchTool extends BaseTool {
  name = "web_fetch";
  permissions: SandboxPermission[] = ["net"];
}
```

## Déclaration côté agent (config)

Chaque agent a un ensemble de permissions maximales :

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-6",
      "sandbox": {
        "allowedPermissions": ["read", "write", "run", "net"],
        "networkAllow": ["api.anthropic.com", "api.openai.com"],
        "maxDurationSec": 30
      }
    }
  }
}
```

## Résolution au runtime (broker)

```
1. Agent demande : execTool("shell", { command: "ls" })
2. Broker regarde :
   - Shell a besoin de : ["run"]
   - Agent autorise max : ["read", "write", "run", "net"]
   - Intersection : ["run"]
3. Broker crée la Sandbox avec : --allow-run
4. Si l'outil demande une permission que l'agent n'autorise pas → refus
```

## Refus explicite (AX : structured error)

```typescript
{
  code: "SANDBOX_PERMISSION_DENIED",
  context: {
    tool: "shell",
    required: ["run"],
    agentAllowed: ["read"],
    denied: ["run"]
  },
  recovery: "Add 'run' to agent sandbox.allowedPermissions"
}
```

## Network allowlist

En plus des permissions Deno, la Sandbox a un **network allowlist** :

- Par défaut : seul le broker est accessible
- L'agent peut ajouter des domaines spécifiques (API LLM, etc.)
- Les domaines sont validés par le broker (pas de wildcard dangereux)

## Flux complet

```
Agent (Subhosting)          Broker (Deploy)              Sandbox (éphémère)
     │                           │                            │
     │ tool_request: "shell"     │                            │
     ├──────────────────────────►│                            │
     │                           │ 1. Vérifie permissions     │
     │                           │    tool needs: [run]       │
     │                           │    agent allows: [run,read]│
     │                           │    → OK, intersection: [run]│
     │                           │                            │
     │                           │ 2. Crée Sandbox            │
     │                           ├───────────────────────────►│
     │                           │    --allow-run              │
     │                           │    network: [broker-url]    │
     │                           │    timeout: 30s             │
     │                           │                            │
     │                           │ 3. Exécute le code         │
     │                           │                            │ ls -la
     │                           │◄───────────────────────────┤
     │                           │    résultat                │
     │                           │                            │
     │                           │ 4. Détruit Sandbox         │
     │                           │           ╳                │
     │◄──────────────────────────┤
     │ tool_response             │
```

## Justification

- **Moindre privilège** — la sandbox n'a jamais plus que nécessaire
- **AX : explicite** — chaque outil déclare ses besoins, pas de permission
  implicite
- **Défense en profondeur** — même si un outil est compromis, il ne peut pas
  dépasser ses permissions déclarées
- **Configurable par agent** — un agent "lecture seule" peut interdire `run` et
  `write`
- **Erreurs structurées** — le refus explique ce qui manque et comment corriger

## Conséquences

- Chaque `BaseTool` doit déclarer un champ `permissions`
- Le type `Config` doit inclure `sandbox.allowedPermissions` dans la config
  agent
- Le broker doit calculer l'intersection et la passer à l'API Sandbox
- Un outil qui oublie de déclarer ses permissions → refuse par défaut (safe
  default AX)
