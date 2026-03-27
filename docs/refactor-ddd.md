# Refactor DDD — DenoClaw

**Date :** 2026-03-27
**Statut :** En cours

## Objectif

Passer d'une architecture en 16 slices techniques vers 8 bounded contexts DDD, avec injection de dépendances et types co-localisés.

## Architecture cible

```
src/
  shared/                         Shared Kernel (zéro logique métier)
  agent/                          Bounded Context: Agent
  messaging/                      Bounded Context: Messaging
  orchestration/                  Bounded Context: Orchestration
  llm/                            Bounded Context: LLM Providers
  telemetry/                      Cross-cutting: Observability
  config/                         Config aggregate
  cli/                            Interface utilisateur
```

### Structure détaillée

```
src/
  shared/
    types.ts                      Message, MessageRole, ToolCall, ToolDefinition, ToolResult,
                                  StructuredError, LLMResponse, AgentConfig, AgentEntry,
                                  AgentResponse, SandboxPermission, SandboxConfig, ChannelRouting
    errors.ts                     DenoClawError, ConfigError, ProviderError, ToolError, ChannelError
    log.ts                        Logger (level-based, LOG_LEVEL env)
    helpers.ts                    generateId, getHomeDir, paths, truncate, ensureDir, fileExists
    mod.ts                        Barrel

  agent/
    types.ts                      Skill, CronJob, AgentDefaults, AgentsConfig, ToolsConfig
    loop.ts                       AgentLoop (mode local, ReAct)
    runtime.ts                    AgentRuntime (mode distribué, ex subhosting/)
    context.ts                    ContextBuilder (system prompt)
    memory.ts                     Memory (KV conversation history)
    skills.ts                     SkillsLoader (charge ~/.denoclaw/skills/*.md)
    cron.ts                       CronManager (ex cron/mod.ts)
    tools/
      types.ts                    BuiltinToolName, BUILTIN_TOOL_PERMISSIONS
      registry.ts                 BaseTool, ToolRegistry (getToolPermissions)
      shell.ts                    ShellTool
      file.ts                     ReadFileTool, WriteFileTool
      web.ts                      WebFetchTool
      mod.ts                      Barrel tools
    mod.ts                        Barrel agent

  messaging/
    types.ts                      ChannelMessage, Session, TelegramConfig, DiscordConfig,
                                  WebhookConfig, ChannelsConfig
    bus.ts                        MessageBus (ex bus/mod.ts, injectable)
    session.ts                    SessionManager (ex session/mod.ts, injectable)
    channels/
      base.ts                    BaseChannel, OnMessage
      console.ts                 ConsoleChannel
      telegram.ts                TelegramChannel
      webhook.ts                 WebhookChannel
      manager.ts                 ChannelManager (injectable)
      mod.ts                     Barrel channels
    a2a/
      types.ts                   AgentCard, AgentSkill, Task, A2AMessage, Part, etc.
      client.ts                  A2AClient
      server.ts                  A2AServer
      card.ts                    generateAgentCard, generateAllCards
      tasks.ts                   TaskStore
      mod.ts                     Barrel A2A
    mod.ts                        Barrel messaging

  orchestration/
    types.ts                      BrokerMessageType, BrokerMessage, LLMRequest, ToolRequest,
                                  ToolResponsePayload, AgentMessagePayload, TunnelType,
                                  TunnelCapabilities
    broker.ts                     BrokerServer (ex broker/server.ts)
    client.ts                     BrokerClient (ex broker/client.ts)
    auth.ts                       AuthManager, AuthErrorCode, InviteToken, SessionToken, AuthResult
    relay.ts                      LocalRelay (ex relay/local.ts)
    gateway.ts                    Gateway (ex gateway/mod.ts)
    sandbox.ts                    SandboxManager (ex sandbox/mod.ts)
    mod.ts                        Barrel orchestration

  llm/
    types.ts                      ProviderConfig, ProvidersConfig
    base.ts                       BaseProvider, OpenAICompatProvider, AnthropicProvider
    ollama.ts                     OllamaProvider
    cli.ts                        CLIProvider
    manager.ts                    ProviderManager
    mod.ts                        Barrel LLM

  telemetry/                      Inchangé
    metrics.ts                    MetricsCollector, AgentMetrics
    mod.ts                        initTelemetry, withSpan, span*

  config/
    types.ts                      Config (assemble sub-configs de chaque domaine)
    loader.ts                     loadConfig, saveConfig, getConfig, getConfigOrDefault
    mod.ts                        Barrel config

  cli/                            Inchangé
    prompt.ts                     ask, confirm, choose, print, success, warn, error
    setup.ts                      setupProvider, setupChannel, setupAgent, publish*
    agents.ts                     listAgents, createAgent, deleteAgent
```

## Import boundaries

```
shared/          <- rien (racine du graphe)
llm/             <- shared/
telemetry/       <- shared/
agent/           <- shared/, telemetry/
messaging/       <- shared/, agent/ (a2a/card utilise AgentEntry)
config/          <- shared/, agent/, messaging/, llm/
orchestration/   <- shared/, agent/, llm/, messaging/, telemetry/, config/
cli/             <- shared/, config/, agent/, messaging/, orchestration/
main.ts          <- tout
```

Règles :
- Chaque domaine ne peut importer que des domaines listés ci-dessus
- `orchestration/` ne peut JAMAIS importer depuis `cli/`
- `agent/` ne peut JAMAIS importer depuis `orchestration/`
- Les imports entre domaines passent par le `mod.ts` barrel (sauf shared/ qui est direct)

## DI : suppression des singletons

### Avant

```typescript
// Couplage implicite via module-level state
const bus = getMessageBus();
const sm = getSessionManager();
const cm = getChannelManager();
```

### Après

```typescript
// Injection explicite via constructeur
const kv = await Deno.openKv();
const bus = new MessageBus(kv);           // ou in-memory fallback
const session = new SessionManager(kv);
const channels = new ChannelManager(bus);
const auth = new AuthManager(kv);         // deja fait
```

Modules concernés :
- `MessageBus` : recevoir `kv` en constructeur (KV Queue ou in-memory fallback)
- `SessionManager` : recevoir `kv` en constructeur
- `ChannelManager` : recevoir `bus` en constructeur
- `Gateway` : recevoir `{ channels, session, bus }` en constructeur
- `BrokerServer` : recevoir `kv` en constructeur (passer à `AuthManager`)

## Mapping avant/après

| Avant | Après | Action |
|---|---|---|
| `src/types.ts` | Split en 6 `types.ts` | Éclaté |
| `src/utils/errors.ts` | `src/shared/errors.ts` | Déplacé |
| `src/utils/log.ts` | `src/shared/log.ts` | Déplacé |
| `src/utils/helpers.ts` | `src/shared/helpers.ts` | Déplacé |
| `src/utils/mod.ts` | `src/shared/mod.ts` | Déplacé |
| `src/agent/loop.ts` | `src/agent/loop.ts` | Inchangé |
| `src/agent/context.ts` | `src/agent/context.ts` | Inchangé |
| `src/agent/memory.ts` | `src/agent/memory.ts` | Inchangé |
| `src/agent/skills.ts` | `src/agent/skills.ts` | Inchangé |
| `src/agent/tools/*` | `src/agent/tools/*` | Inchangé (+ types.ts ajouté) |
| `src/subhosting/agent_runtime.ts` | `src/agent/runtime.ts` | Fusionné |
| `src/subhosting/mod.ts` | Supprimé | Fusionné |
| `src/cron/mod.ts` | `src/agent/cron.ts` | Fusionné |
| `src/bus/mod.ts` | `src/messaging/bus.ts` | Fusionné |
| `src/session/mod.ts` | `src/messaging/session.ts` | Fusionné |
| `src/channels/base.ts` | `src/messaging/channels/base.ts` | Déplacé |
| `src/channels/console.ts` | `src/messaging/channels/console.ts` | Déplacé |
| `src/channels/telegram.ts` | `src/messaging/channels/telegram.ts` | Déplacé |
| `src/channels/webhook.ts` | `src/messaging/channels/webhook.ts` | Déplacé |
| `src/channels/manager.ts` | `src/messaging/channels/manager.ts` | Déplacé |
| `src/channels/mod.ts` | `src/messaging/channels/mod.ts` | Déplacé |
| `src/a2a/types.ts` | `src/messaging/a2a/types.ts` | Déplacé |
| `src/a2a/client.ts` | `src/messaging/a2a/client.ts` | Déplacé |
| `src/a2a/server.ts` | `src/messaging/a2a/server.ts` | Déplacé |
| `src/a2a/card.ts` | `src/messaging/a2a/card.ts` | Déplacé |
| `src/a2a/tasks.ts` | `src/messaging/a2a/tasks.ts` | Déplacé |
| `src/a2a/mod.ts` | `src/messaging/a2a/mod.ts` | Déplacé |
| `src/broker/server.ts` | `src/orchestration/broker.ts` | Renommé |
| `src/broker/client.ts` | `src/orchestration/client.ts` | Déplacé |
| `src/broker/auth.ts` | `src/orchestration/auth.ts` | Déplacé |
| `src/broker/types.ts` | `src/orchestration/types.ts` | Déplacé |
| `src/broker/mod.ts` | `src/orchestration/mod.ts` | Déplacé |
| `src/relay/local.ts` | `src/orchestration/relay.ts` | Fusionné |
| `src/relay/mod.ts` | Supprimé | Fusionné |
| `src/gateway/mod.ts` | `src/orchestration/gateway.ts` | Fusionné |
| `src/sandbox/mod.ts` | `src/orchestration/sandbox.ts` | Fusionné |
| `src/providers/base.ts` | `src/llm/base.ts` | Renommé |
| `src/providers/ollama.ts` | `src/llm/ollama.ts` | Renommé |
| `src/providers/cli.ts` | `src/llm/cli.ts` | Renommé |
| `src/providers/manager.ts` | `src/llm/manager.ts` | Renommé |
| `src/providers/mod.ts` | `src/llm/mod.ts` | Renommé |
| `src/config/mod.ts` | `src/config/loader.ts` | Renommé |
| `src/telemetry/*` | `src/telemetry/*` | Inchangé |
| `src/cli/*` | `src/cli/*` | Inchangé |

## Checklist

### Phase 0 : Préparation

- [ ] Créer les dossiers cibles (`shared/`, `messaging/`, `orchestration/`, `llm/`)
- [ ] Snapshot git propre (commit l'état actuel avant refactor)

### Phase 1 : Shared Kernel

- [ ] Créer `src/shared/types.ts` — extraire les types cross-domain de `src/types.ts`
- [ ] Déplacer `src/utils/errors.ts` → `src/shared/errors.ts`
- [ ] Déplacer `src/utils/log.ts` → `src/shared/log.ts`
- [ ] Déplacer `src/utils/helpers.ts` → `src/shared/helpers.ts`
- [ ] Créer `src/shared/mod.ts` (barrel)
- [ ] Mettre à jour tous les imports `../utils/` → `../shared/`
- [ ] Supprimer `src/utils/` (après migration)
- [ ] Tests : `deno task check` + `deno task test`

### Phase 2 : Agent domain

- [ ] Créer `src/agent/types.ts` — extraire `Skill`, `CronJob`, `AgentDefaults`, `AgentsConfig`, `ToolsConfig`
- [ ] Créer `src/agent/tools/types.ts` — extraire `BuiltinToolName`, `BUILTIN_TOOL_PERMISSIONS`
- [ ] Déplacer `src/subhosting/agent_runtime.ts` → `src/agent/runtime.ts`
- [ ] Déplacer `src/cron/mod.ts` → `src/agent/cron.ts`
- [ ] Mettre à jour les imports dans `agent/loop.ts`, `agent/runtime.ts`, `agent/context.ts`, `agent/skills.ts`
- [ ] Créer `src/agent/mod.ts` (barrel complet)
- [ ] Supprimer `src/subhosting/`, `src/cron/`
- [ ] Tests : `deno task check` + `deno task test`

### Phase 3 : LLM domain

- [ ] Créer `src/llm/types.ts` — extraire `ProviderConfig`, `ProvidersConfig`
- [ ] Déplacer `src/providers/base.ts` → `src/llm/base.ts`
- [ ] Déplacer `src/providers/ollama.ts` → `src/llm/ollama.ts`
- [ ] Déplacer `src/providers/cli.ts` → `src/llm/cli.ts`
- [ ] Déplacer `src/providers/manager.ts` → `src/llm/manager.ts`
- [ ] Créer `src/llm/mod.ts` (barrel)
- [ ] Mettre à jour les imports dans `agent/loop.ts`, `orchestration/broker.ts`
- [ ] Supprimer `src/providers/`
- [ ] Tests : `deno task check` + `deno task test`

### Phase 4 : Messaging domain

- [ ] Créer `src/messaging/types.ts` — extraire `ChannelMessage`, `Session`, configs channels
- [ ] Déplacer `src/bus/mod.ts` → `src/messaging/bus.ts`
- [ ] Déplacer `src/session/mod.ts` → `src/messaging/session.ts`
- [ ] Déplacer `src/channels/*` → `src/messaging/channels/*`
- [ ] Déplacer `src/a2a/*` → `src/messaging/a2a/*`
- [ ] Créer `src/messaging/mod.ts` (barrel)
- [ ] Mettre à jour les imports dans `orchestration/gateway.ts`, `main.ts`
- [ ] Supprimer `src/bus/`, `src/session/`, `src/channels/`, `src/a2a/`
- [ ] Tests : `deno task check` + `deno task test`

### Phase 5 : Orchestration domain

- [ ] Déplacer `src/broker/server.ts` → `src/orchestration/broker.ts`
- [ ] Déplacer `src/broker/client.ts` → `src/orchestration/client.ts`
- [ ] Déplacer `src/broker/auth.ts` → `src/orchestration/auth.ts`
- [ ] Déplacer `src/broker/types.ts` → `src/orchestration/types.ts`
- [ ] Déplacer `src/relay/local.ts` → `src/orchestration/relay.ts`
- [ ] Déplacer `src/gateway/mod.ts` → `src/orchestration/gateway.ts`
- [ ] Déplacer `src/sandbox/mod.ts` → `src/orchestration/sandbox.ts`
- [ ] Créer `src/orchestration/mod.ts` (barrel)
- [ ] Mettre à jour les imports dans `agent/runtime.ts`, `main.ts`
- [ ] Supprimer `src/broker/`, `src/relay/`, `src/gateway/`, `src/sandbox/`
- [ ] Tests : `deno task check` + `deno task test`

### Phase 6 : Config aggregate

- [ ] Créer `src/config/types.ts` — `Config` assemble les sub-configs de chaque domaine
- [ ] Renommer `src/config/mod.ts` → `src/config/loader.ts`
- [ ] Créer `src/config/mod.ts` (barrel)
- [ ] Mettre à jour les imports dans `cli/setup.ts`, `cli/agents.ts`, `main.ts`
- [ ] Tests : `deno task check` + `deno task test`

### Phase 7 : DI — suppression des singletons

- [ ] `MessageBus` : constructeur `(kv?: Deno.Kv)`, supprimer `getMessageBus()`
- [ ] `SessionManager` : constructeur `(kv?: Deno.Kv)`, supprimer `getSessionManager()`
- [ ] `ChannelManager` : constructeur `(bus: MessageBus)`, supprimer `getChannelManager()`
- [ ] `Gateway` : constructeur `(config, { bus, session, channels })`
- [ ] `BrokerServer` : passer `kv` au constructeur (déjà partiellement fait)
- [ ] Mettre à jour `main.ts` : wiring explicite
- [ ] Mettre à jour `orchestration/gateway.ts` : recevoir les deps
- [ ] Tests : `deno task check` + `deno task test`

### Phase 8 : Entry points + barrels

- [ ] Réécrire `main.ts` avec les nouveaux imports
- [ ] Réécrire `mod.ts` (public API barrel) avec les nouveaux chemins
- [ ] Mettre à jour `CLAUDE.md` — nouvelles import boundaries, structure, conventions
- [ ] Tests finaux : `deno task check` + `deno task lint` + `deno task test`

### Phase 9 : Nettoyage

- [ ] Supprimer tous les anciens dossiers vides
- [ ] Supprimer `src/types.ts` (doit être vide à ce stade)
- [ ] Vérifier qu'aucun fichier test n'a été oublié — tous les `*_test.ts` au bon endroit
- [ ] `deno task check` + `deno task lint` + `deno task test` + `deno task fmt`
- [ ] Commit final

## Tests à déplacer

| Avant | Après |
|---|---|
| `src/utils/errors_test.ts` | `src/shared/errors_test.ts` |
| `src/utils/helpers_test.ts` | `src/shared/helpers_test.ts` |
| `src/agent/context_test.ts` | Inchangé |
| `src/agent/memory_test.ts` | Inchangé |
| `src/agent/skills_test.ts` | Inchangé |
| `src/agent/tools/registry_test.ts` | Inchangé |
| `src/agent/tools/shell_test.ts` | Inchangé |
| `src/agent/tools/file_test.ts` | Inchangé |
| `src/agent/tools/web_test.ts` | Inchangé |
| `src/bus/bus_test.ts` | `src/messaging/bus_test.ts` |
| `src/session/session_test.ts` | `src/messaging/session_test.ts` |
| `src/config/config_test.ts` | `src/config/loader_test.ts` |
| `src/providers/base_test.ts` | `src/llm/base_test.ts` |
| `src/providers/manager_test.ts` | `src/llm/manager_test.ts` |
| `src/broker/auth_test.ts` | `src/orchestration/auth_test.ts` |

## Notes

- Chaque phase se termine par `deno task check` + `deno task test` — on ne passe à la suivante que si tout est vert
- Le refactor est purement structurel — aucun changement de logique métier
- Les phases 1-6 sont du déplacement de fichiers + mise à jour d'imports
- La phase 7 (DI) est le seul changement de design (suppression singletons)
- On peut commit à chaque phase (chaque phase est un état compilable)
