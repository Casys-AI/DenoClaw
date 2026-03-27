# Refactor DDD — DenoClaw

**Date :** 2026-03-27
**Statut :** Terminé

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
telemetry/       <- shared/ (cross-cutting, importable par tous les domaines)
llm/             <- shared/, telemetry/
agent/           <- shared/, telemetry/
messaging/       <- shared/, agent/ (a2a/card), telemetry/
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

- [x] Créer les dossiers cibles (`shared/`, `messaging/`, `orchestration/`, `llm/`)
- [x] Snapshot git propre (commit l'état actuel avant refactor)

### Phase 1 : Shared Kernel

- [x] Créer `src/shared/types.ts` — extraire les types cross-domain de `src/types.ts`
- [x] Déplacer `src/utils/errors.ts` → `src/shared/errors.ts`
- [x] Déplacer `src/utils/log.ts` → `src/shared/log.ts`
- [x] Déplacer `src/utils/helpers.ts` → `src/shared/helpers.ts`
- [x] Créer `src/shared/mod.ts` (barrel)
- [x] Mettre à jour tous les imports `../utils/` → `../shared/`
- [x] Supprimer `src/utils/` (après migration)
- [x] Tests : `deno task check` + `deno task test`

### Phase 2 : Agent domain

- [x] Créer `src/agent/types.ts` — `AgentConfig`, `AgentResponse`, `Skill`, `CronJob`, `AgentDefaults`, `AgentsConfig`, `ToolsConfig`
- [x] Créer `src/agent/tools/types.ts` — `BuiltinToolName`, `BUILTIN_TOOL_PERMISSIONS`
- [x] Déplacer `src/subhosting/agent_runtime.ts` → `src/agent/runtime.ts`
- [x] Déplacer `src/cron/mod.ts` → `src/agent/cron.ts`
- [x] Mettre à jour les imports dans `agent/loop.ts`, `agent/runtime.ts`, `agent/context.ts`, `agent/skills.ts`
- [x] Créer `src/agent/mod.ts` (barrel complet avec `AgentLoopDeps`)
- [x] Supprimer `src/subhosting/`, `src/cron/`
- [x] Tests : `deno task check` + `deno task test`

### Phase 3 : LLM domain

- [x] Créer `src/llm/types.ts` — `ProviderConfig`, `ProvidersConfig`
- [x] Déplacer `src/providers/base.ts` → `src/llm/base.ts`
- [x] Déplacer `src/providers/ollama.ts` → `src/llm/ollama.ts`
- [x] Déplacer `src/providers/cli.ts` → `src/llm/cli.ts`
- [x] Déplacer `src/providers/manager.ts` → `src/llm/manager.ts` (prend `ProvidersConfig` pas `Config`)
- [x] Créer `src/llm/mod.ts` (barrel avec `OllamaProvider`)
- [x] Supprimer `src/providers/`
- [x] Tests : `deno task check` + `deno task test`

### Phase 4 : Messaging domain

- [x] Créer `src/messaging/types.ts` — `ChannelMessage`, `Session`, configs channels
- [x] Déplacer `src/bus/mod.ts` → `src/messaging/bus.ts`
- [x] Déplacer `src/session/mod.ts` → `src/messaging/session.ts`
- [x] Déplacer `src/channels/*` → `src/messaging/channels/*`
- [x] Déplacer `src/a2a/*` → `src/messaging/a2a/*`
- [x] Créer `src/messaging/mod.ts` (barrel)
- [x] Supprimer `src/bus/`, `src/session/`, `src/channels/`, `src/a2a/`
- [x] Tests : `deno task check` + `deno task test`

### Phase 5 : Orchestration domain

- [x] Déplacer `src/broker/server.ts` → `src/orchestration/broker.ts`
- [x] Déplacer `src/broker/client.ts` → `src/orchestration/client.ts` (implements `AgentBrokerPort`)
- [x] Déplacer `src/broker/auth.ts` → `src/orchestration/auth.ts`
- [x] Déplacer `src/broker/types.ts` → `src/orchestration/types.ts`
- [x] Déplacer `src/relay/local.ts` → `src/orchestration/relay.ts`
- [x] Déplacer `src/gateway/mod.ts` → `src/orchestration/gateway.ts` (DI + AuthManager + close())
- [x] Déplacer `src/sandbox/mod.ts` → `src/orchestration/sandbox.ts` (`SandboxApiConfig`)
- [x] Créer `src/orchestration/mod.ts` (barrel avec `BrokerServerDeps`, `GatewayDeps`)
- [x] Supprimer `src/broker/`, `src/relay/`, `src/gateway/`, `src/sandbox/`
- [x] Tests : `deno task check` + `deno task test`

### Phase 6 : Config aggregate

- [x] Créer `src/config/types.ts` — `Config` assemble les sub-configs de chaque domaine
- [x] Renommer `src/config/mod.ts` → `src/config/loader.ts`
- [x] Créer `src/config/mod.ts` (barrel)
- [x] Mettre à jour les imports dans `cli/setup.ts`, `cli/agents.ts`, `main.ts`
- [x] Tests : `deno task check` + `deno task test`

### Phase 7 : DI — suppression des singletons

- [x] `MessageBus` : constructeur `(kv?: Deno.Kv)`, supprimer `getMessageBus()`
- [x] `SessionManager` : constructeur `(kv?: Deno.Kv)`, supprimer `getSessionManager()`
- [x] `ChannelManager` : constructeur `(bus: MessageBus)`, supprimer `getChannelManager()`
- [x] `Gateway` : constructeur `(config, { bus, session, channels, auth? })`
- [x] `BrokerServer` : constructeur `(config, deps?: BrokerServerDeps)`
- [x] `AgentLoop` : constructeur avec `AgentLoopDeps` optionnel + `close()`
- [x] Mettre à jour `main.ts` : wiring explicite + `loop.close()` dans finally
- [x] Mettre à jour `orchestration/gateway.ts` : `agent.close()` dans finally
- [x] Tests : `deno task check` + `deno task test`

### Phase 8 : Entry points + barrels

- [x] Réécrire `main.ts` avec les nouveaux imports DDD
- [x] Réécrire `mod.ts` (public API barrel) avec les nouveaux chemins
- [x] Tests finaux : `deno task check` + `deno task lint` + `deno task test`

### Phase 9 : Nettoyage

- [x] Supprimer tous les anciens dossiers (utils, types.ts, providers, broker, bus, session, channels, a2a, gateway, sandbox, subhosting, cron, relay)
- [x] Supprimer `src/config/new_mod.ts` (artifact orphelin)
- [x] Tous les `*_test.ts` au bon endroit
- [x] `deno task check` + `deno task lint` + `deno task test` + `deno task fmt`
- [x] Commit final

### Bonus : Review + fixes post-refactor

- [x] Boundary violation `agent/ → orchestration/` : `AgentBrokerPort` interface (DI)
- [x] Boundary violation `llm/ → config/` : `ProviderManager(ProvidersConfig)` (dependency inversion)
- [x] Cycle `agent ↔ config` : `AgentLoopConfig` local (structural typing)
- [x] Auth unifiée : Gateway délègue à AuthManager
- [x] Type ownership : `AgentConfig`, `AgentResponse` → `agent/types.ts`
- [x] Barrels complets : `AgentLoopDeps`, `BrokerServerDeps`, `GatewayDeps`, `createDefaultConfig`
- [x] Gateway `agent.close()` dans tous les paths
- [x] publishAgent utilise le vrai AgentRuntime
- [x] `SandboxConfig` → `SandboxApiConfig` (collision de nom résolue)
- [x] Vérifié par 4 agents (3 Claude + 1 Codex) : 10/10 PASS

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
