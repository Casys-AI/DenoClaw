# DDD Refactor — DenoClaw

**Date:** 2026-03-27 **Status:** Completed

## Goal

Move from an architecture with 16 technical slices to 8 DDD bounded contexts,
with dependency injection and co-located types.

## Target architecture

```
src/
  shared/                         Shared Kernel (zero business logic)
  agent/                          Bounded Context: Agent
  messaging/                      Bounded Context: Messaging
  orchestration/                  Bounded Context: Orchestration
  llm/                            Bounded Context: LLM Providers
  telemetry/                      Cross-cutting: Observability
  config/                         Config aggregate
  cli/                            User interface
```

### Detailed structure

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
    loop.ts                       AgentLoop (local mode, ReAct)
    runtime.ts                    AgentRuntime (distributed mode, formerly subhosting/)
    context.ts                    ContextBuilder (system prompt)
    memory.ts                     Memory (KV conversation history)
    skills.ts                     SkillsLoader (loads ~/.denoclaw/skills/*.md)
    cron.ts                       CronManager (formerly cron/mod.ts)
    tools/
      types.ts                    BuiltinToolName, BUILTIN_TOOL_PERMISSIONS
      registry.ts                 BaseTool, ToolRegistry (getToolPermissions)
      shell.ts                    ShellTool
      file.ts                     ReadFileTool, WriteFileTool
      web.ts                      WebFetchTool
      mod.ts                      Tools barrel
    mod.ts                        Agent barrel

  messaging/
    types.ts                      ChannelMessage, Session, TelegramConfig, DiscordConfig,
                                  WebhookConfig, ChannelsConfig
    bus.ts                        MessageBus (formerly bus/mod.ts, injectable)
    session.ts                    SessionManager (formerly session/mod.ts, injectable)
    channels/
      base.ts                     BaseChannel, OnMessage
      console.ts                  ConsoleChannel
      telegram.ts                 TelegramChannel
      webhook.ts                  WebhookChannel
      manager.ts                  ChannelManager (injectable)
      mod.ts                      Channels barrel
    a2a/
      types.ts                    AgentCard, AgentSkill, Task, A2AMessage, Part, etc.
      client.ts                   A2AClient
      server.ts                   A2AServer
      card.ts                     generateAgentCard, generateAllCards
      tasks.ts                    TaskStore
      mod.ts                      A2A barrel
    mod.ts                        Messaging barrel

  orchestration/
    types.ts                      BrokerMessageType, BrokerMessage, LLMRequest, ToolRequest,
                                  ToolResponsePayload, AgentMessagePayload, TunnelType,
                                  TunnelCapabilities
    broker.ts                     BrokerServer (formerly broker/server.ts)
    client.ts                     BrokerClient (formerly broker/client.ts)
    auth.ts                       AuthManager, AuthErrorCode, InviteToken, SessionToken, AuthResult
    relay.ts                      LocalRelay (formerly relay/local.ts)
    gateway.ts                    Gateway (formerly gateway/mod.ts)
    sandbox.ts                    SandboxManager (formerly sandbox/mod.ts)
    mod.ts                        Orchestration barrel

  llm/
    types.ts                      ProviderConfig, ProvidersConfig
    base.ts                       BaseProvider, OpenAICompatProvider, AnthropicProvider
    ollama.ts                     OllamaProvider
    cli.ts                        CLIProvider
    manager.ts                    ProviderManager
    mod.ts                        LLM barrel

  telemetry/                      Unchanged
    metrics.ts                    MetricsCollector, AgentMetrics
    mod.ts                        initTelemetry, withSpan, span*

  config/
    types.ts                      Config (assembles sub-configs from each domain)
    loader.ts                     loadConfig, saveConfig, getConfig, getConfigOrDefault
    mod.ts                        Config barrel

  cli/                            Unchanged
    prompt.ts                     ask, confirm, choose, print, success, warn, error
    setup.ts                      setupProvider, setupChannel, setupAgent, publish*
    agents.ts                     listAgents, createAgent, deleteAgent
```

## Import boundaries

```
shared/          <- nothing (root of the graph)
telemetry/       <- shared/ (cross-cutting, importable by all domains)
llm/             <- shared/, telemetry/
agent/           <- shared/, telemetry/
messaging/       <- shared/, agent/ (a2a/card), telemetry/
config/          <- shared/, agent/, messaging/, llm/
orchestration/   <- shared/, agent/, llm/, messaging/, telemetry/, config/
cli/             <- shared/, config/, agent/, messaging/, orchestration/
main.ts          <- everything
```

Rules:

- Each domain may only import from the domains listed above
- `orchestration/` must NEVER import from `cli/`
- `agent/` must NEVER import from `orchestration/`
- Cross-domain imports go through the `mod.ts` barrel (except `shared/`, which
  is direct)

## DI: removing singletons

### Before

```typescript
// Implicit coupling through module-level state
const bus = getMessageBus();
const sm = getSessionManager();
const cm = getChannelManager();
```

### After

```typescript
// Explicit constructor injection
const kv = await Deno.openKv();
const bus = new MessageBus(kv); // or in-memory fallback
const session = new SessionManager(kv);
const channels = new ChannelManager(bus);
const auth = new AuthManager(kv); // already done
```

Affected modules:

- `MessageBus`: take `kv` in the constructor (KV Queue or in-memory fallback)
- `SessionManager`: take `kv` in the constructor
- `ChannelManager`: take `bus` in the constructor
- `Gateway`: take `{ channels, session, bus }` in the constructor
- `BrokerServer`: take `kv` in the constructor (then pass it to `AuthManager`)

## Before/after mapping

| Before                            | After                                | Action                         |
| --------------------------------- | ------------------------------------ | ------------------------------ |
| `src/types.ts`                    | Split into 6 `types.ts` files        | Split                          |
| `src/utils/errors.ts`             | `src/shared/errors.ts`               | Moved                          |
| `src/utils/log.ts`                | `src/shared/log.ts`                  | Moved                          |
| `src/utils/helpers.ts`            | `src/shared/helpers.ts`              | Moved                          |
| `src/utils/mod.ts`                | `src/shared/mod.ts`                  | Moved                          |
| `src/agent/loop.ts`               | `src/agent/loop.ts`                  | Unchanged                      |
| `src/agent/context.ts`            | `src/agent/context.ts`               | Unchanged                      |
| `src/agent/memory.ts`             | `src/agent/memory.ts`                | Unchanged                      |
| `src/agent/skills.ts`             | `src/agent/skills.ts`                | Unchanged                      |
| `src/agent/tools/*`               | `src/agent/tools/*`                  | Unchanged (+ `types.ts` added) |
| `src/subhosting/agent_runtime.ts` | `src/agent/runtime.ts`               | Merged                         |
| `src/subhosting/mod.ts`           | Removed                              | Merged                         |
| `src/cron/mod.ts`                 | `src/agent/cron.ts`                  | Merged                         |
| `src/bus/mod.ts`                  | `src/messaging/bus.ts`               | Merged                         |
| `src/session/mod.ts`              | `src/messaging/session.ts`           | Merged                         |
| `src/channels/base.ts`            | `src/messaging/channels/base.ts`     | Moved                          |
| `src/channels/console.ts`         | `src/messaging/channels/console.ts`  | Moved                          |
| `src/channels/telegram.ts`        | `src/messaging/channels/telegram.ts` | Moved                          |
| `src/channels/webhook.ts`         | `src/messaging/channels/webhook.ts`  | Moved                          |
| `src/channels/manager.ts`         | `src/messaging/channels/manager.ts`  | Moved                          |
| `src/channels/mod.ts`             | `src/messaging/channels/mod.ts`      | Moved                          |
| `src/a2a/types.ts`                | `src/messaging/a2a/types.ts`         | Moved                          |
| `src/a2a/client.ts`               | `src/messaging/a2a/client.ts`        | Moved                          |
| `src/a2a/server.ts`               | `src/messaging/a2a/server.ts`        | Moved                          |
| `src/a2a/card.ts`                 | `src/messaging/a2a/card.ts`          | Moved                          |
| `src/a2a/tasks.ts`                | `src/messaging/a2a/tasks.ts`         | Moved                          |
| `src/a2a/mod.ts`                  | `src/messaging/a2a/mod.ts`           | Moved                          |
| `src/broker/server.ts`            | `src/orchestration/broker.ts`        | Renamed                        |
| `src/broker/client.ts`            | `src/orchestration/client.ts`        | Moved                          |
| `src/broker/auth.ts`              | `src/orchestration/auth.ts`          | Moved                          |
| `src/broker/types.ts`             | `src/orchestration/types.ts`         | Moved                          |
| `src/broker/mod.ts`               | `src/orchestration/mod.ts`           | Moved                          |
| `src/relay/local.ts`              | `src/orchestration/relay.ts`         | Merged                         |
| `src/relay/mod.ts`                | Removed                              | Merged                         |
| `src/gateway/mod.ts`              | `src/orchestration/gateway.ts`       | Merged                         |
| `src/sandbox/mod.ts`              | `src/orchestration/sandbox.ts`       | Merged                         |
| `src/providers/base.ts`           | `src/llm/base.ts`                    | Renamed                        |
| `src/providers/ollama.ts`         | `src/llm/ollama.ts`                  | Renamed                        |
| `src/providers/cli.ts`            | `src/llm/cli.ts`                     | Renamed                        |
| `src/providers/manager.ts`        | `src/llm/manager.ts`                 | Renamed                        |
| `src/providers/mod.ts`            | `src/llm/mod.ts`                     | Renamed                        |
| `src/config/mod.ts`               | `src/config/loader.ts`               | Renamed                        |
| `src/telemetry/*`                 | `src/telemetry/*`                    | Unchanged                      |
| `src/cli/*`                       | `src/cli/*`                          | Unchanged                      |

## Checklist

### Phase 0: Preparation

- [x] Create the target directories (`shared/`, `messaging/`, `orchestration/`,
      `llm/`)
- [x] Clean git snapshot (commit current state before refactor)

### Phase 1: Shared Kernel

- [x] Create `src/shared/types.ts` — extract cross-domain types from
      `src/types.ts`
- [x] Move `src/utils/errors.ts` → `src/shared/errors.ts`
- [x] Move `src/utils/log.ts` → `src/shared/log.ts`
- [x] Move `src/utils/helpers.ts` → `src/shared/helpers.ts`
- [x] Create `src/shared/mod.ts` (barrel)
- [x] Update all `../utils/` imports → `../shared/`
- [x] Delete `src/utils/` (after migration)
- [x] Tests: `deno task check` + `deno task test`

### Phase 2: Agent domain

- [x] Create `src/agent/types.ts` — `AgentConfig`, `AgentResponse`, `Skill`,
      `CronJob`, `AgentDefaults`, `AgentsConfig`, `ToolsConfig`
- [x] Create `src/agent/tools/types.ts` — `BuiltinToolName`,
      `BUILTIN_TOOL_PERMISSIONS`
- [x] Move `src/subhosting/agent_runtime.ts` → `src/agent/runtime.ts`
- [x] Move `src/cron/mod.ts` → `src/agent/cron.ts`
- [x] Update imports in `agent/loop.ts`, `agent/runtime.ts`, `agent/context.ts`,
      `agent/skills.ts`
- [x] Create `src/agent/mod.ts` (full barrel with `AgentLoopDeps`)
- [x] Delete `src/subhosting/`, `src/cron/`
- [x] Tests: `deno task check` + `deno task test`

### Phase 3: LLM domain

- [x] Create `src/llm/types.ts` — `ProviderConfig`, `ProvidersConfig`
- [x] Move `src/providers/base.ts` → `src/llm/base.ts`
- [x] Move `src/providers/ollama.ts` → `src/llm/ollama.ts`
- [x] Move `src/providers/cli.ts` → `src/llm/cli.ts`
- [x] Move `src/providers/manager.ts` → `src/llm/manager.ts` (takes
      `ProvidersConfig`, not `Config`)
- [x] Create `src/llm/mod.ts` (barrel with `OllamaProvider`)
- [x] Delete `src/providers/`
- [x] Tests: `deno task check` + `deno task test`

### Phase 4: Messaging domain

- [x] Create `src/messaging/types.ts` — `ChannelMessage`, `Session`, channel
      configs
- [x] Move `src/bus/mod.ts` → `src/messaging/bus.ts`
- [x] Move `src/session/mod.ts` → `src/messaging/session.ts`
- [x] Move `src/channels/*` → `src/messaging/channels/*`
- [x] Move `src/a2a/*` → `src/messaging/a2a/*`
- [x] Create `src/messaging/mod.ts` (barrel)
- [x] Delete `src/bus/`, `src/session/`, `src/channels/`, `src/a2a/`
- [x] Tests: `deno task check` + `deno task test`

### Phase 5: Orchestration domain

- [x] Move `src/broker/server.ts` → `src/orchestration/broker.ts`
- [x] Move `src/broker/client.ts` → `src/orchestration/client.ts` (implements
      `AgentBrokerPort`)
- [x] Move `src/broker/auth.ts` → `src/orchestration/auth.ts`
- [x] Move `src/broker/types.ts` → `src/orchestration/types.ts`
- [x] Move `src/relay/local.ts` → `src/orchestration/relay.ts`
- [x] Move `src/gateway/mod.ts` → `src/orchestration/gateway.ts` (DI +
      `AuthManager` + `close()`)
- [x] Move `src/sandbox/mod.ts` → `src/orchestration/sandbox.ts`
      (`SandboxApiConfig`)
- [x] Create `src/orchestration/mod.ts` (barrel with `BrokerServerDeps`,
      `GatewayDeps`)
- [x] Delete `src/broker/`, `src/relay/`, `src/gateway/`, `src/sandbox/`
- [x] Tests: `deno task check` + `deno task test`

### Phase 6: Config aggregate

- [x] Create `src/config/types.ts` — `Config` assembles the sub-configs of each
      domain
- [x] Rename `src/config/mod.ts` → `src/config/loader.ts`
- [x] Create `src/config/mod.ts` (barrel)
- [x] Update imports in `cli/setup.ts`, `cli/agents.ts`, `main.ts`
- [x] Tests: `deno task check` + `deno task test`

### Phase 7: DI — remove singletons

- [x] `MessageBus`: constructor `(kv?: Deno.Kv)`, remove `getMessageBus()`
- [x] `SessionManager`: constructor `(kv?: Deno.Kv)`, remove
      `getSessionManager()`
- [x] `ChannelManager`: constructor `(bus: MessageBus)`, remove
      `getChannelManager()`
- [x] `Gateway`: constructor `(config, { bus, session, channels, auth? })`
- [x] `BrokerServer`: constructor `(config, deps?: BrokerServerDeps)`
- [x] `AgentLoop`: constructor with optional `AgentLoopDeps` + `close()`
- [x] Update `main.ts`: explicit wiring + `loop.close()` in `finally`
- [x] Update `orchestration/gateway.ts`: `agent.close()` in `finally`
- [x] Tests: `deno task check` + `deno task test`

### Phase 8: Entry points + barrels

- [x] Rewrite `main.ts` with the new DDD imports
- [x] Rewrite `mod.ts` (public API barrel) with the new paths
- [x] Final tests: `deno task check` + `deno task lint` + `deno task test`

### Phase 9: Cleanup

- [x] Delete all old directories (utils, `types.ts`, providers, broker, bus,
      session, channels, a2a, gateway, sandbox, subhosting, cron, relay)
- [x] Delete `src/config/new_mod.ts` (orphaned artifact)
- [x] Ensure all `*_test.ts` files are in the right place
- [x] `deno task check` + `deno task lint` + `deno task test` + `deno task fmt`
- [x] Final commit

### Bonus: Post-refactor review + fixes

- [x] Boundary violation `agent/ → orchestration/`: `AgentBrokerPort` interface
      (DI)
- [x] Boundary violation `llm/ → config/`: `ProviderManager(ProvidersConfig)`
      (dependency inversion)
- [x] Cycle `agent ↔ config`: local `AgentLoopConfig` (structural typing)
- [x] Unified auth: Gateway delegates to `AuthManager`
- [x] Type ownership: `AgentConfig`, `AgentResponse` → `agent/types.ts`
- [x] Complete barrels: `AgentLoopDeps`, `BrokerServerDeps`, `GatewayDeps`,
      `createDefaultConfig`
- [x] `Gateway agent.close()` on every path
- [x] `publishAgent` uses the real `AgentRuntime`
- [x] `SandboxConfig` → `SandboxApiConfig` (name collision resolved)
- [x] Verified by 4 agents (3 Claude + 1 Codex): 10/10 PASS

## Tests to move

| Before                             | After                            |
| ---------------------------------- | -------------------------------- |
| `src/utils/errors_test.ts`         | `src/shared/errors_test.ts`      |
| `src/utils/helpers_test.ts`        | `src/shared/helpers_test.ts`     |
| `src/agent/context_test.ts`        | Unchanged                        |
| `src/agent/memory_test.ts`         | Unchanged                        |
| `src/agent/skills_test.ts`         | Unchanged                        |
| `src/agent/tools/registry_test.ts` | Unchanged                        |
| `src/agent/tools/shell_test.ts`    | Unchanged                        |
| `src/agent/tools/file_test.ts`     | Unchanged                        |
| `src/agent/tools/web_test.ts`      | Unchanged                        |
| `src/bus/bus_test.ts`              | `src/messaging/bus_test.ts`      |
| `src/session/session_test.ts`      | `src/messaging/session_test.ts`  |
| `src/config/config_test.ts`        | `src/config/loader_test.ts`      |
| `src/providers/base_test.ts`       | `src/llm/base_test.ts`           |
| `src/providers/manager_test.ts`    | `src/llm/manager_test.ts`        |
| `src/broker/auth_test.ts`          | `src/orchestration/auth_test.ts` |

## Notes

- Each phase ends with `deno task check` + `deno task test`; do not move to the
  next phase until everything is green
- The refactor is purely structural; there is no business-logic change
- Phases 1-6 are file moves plus import updates
- Phase 7 (DI) is the only design-level change (singleton removal)
- Each phase can be committed independently because each phase remains in a
  compilable state
