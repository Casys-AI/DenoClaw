import type {
  AgentConfig,
  AgentDefaults,
  AgentResponse,
  ToolsConfig,
} from "./types.ts";
import type { SandboxConfig } from "../shared/types.ts";
import type { ProvidersConfig } from "../llm/types.ts";
import { ProviderManager } from "../llm/manager.ts";
import { createSandboxBackend } from "./tools/backends/factory.ts";

/** Minimal Config projection required by AgentLoop — no dependency on config/. */
interface AgentLoopConfig {
  agents: { defaults: AgentDefaults };
  providers: ProvidersConfig;
  tools?: ToolsConfig;
}
import { Memory } from "./memory.ts";
import type { MemoryPort } from "./memory_port.ts";
import { ContextBuilder } from "./context.ts";
import type { SkillLoader } from "./skills.ts";
import { EmptySkillLoader, KvSkillsLoader, SkillsLoader } from "./skills.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ShellTool } from "./tools/shell.ts";
import {
  CreateCronTool,
  type CronToolPort,
  DeleteCronTool,
  DisableCronTool,
  EnableCronTool,
  ListCronsTool,
} from "./tools/cron.ts";
import { ReadFileTool, WriteFileTool } from "./tools/file.ts";
import type { WorkspaceContext } from "./tools/file.ts";
import { WebFetchTool } from "./tools/web.ts";
import { SendToAgentTool } from "./tools/send_to_agent.ts";
import type { SendToAgentFn } from "./tools/send_to_agent.ts";
import { MemoryTool } from "./tools/memory.ts";
import type { TraceWriter } from "../telemetry/traces.ts";
import { createLocalRunner } from "./runner.ts";
import { listAgentMemoryFiles } from "./loop_workspace.ts";
import type { AgentRuntimeCapabilities } from "./runtime_capabilities.ts";
import type { AgentRuntimeGrant } from "./runtime_capabilities.ts";
import { join } from "@std/path";
import { isDeployEnvironment } from "../shared/helpers.ts";

export interface AgentLoopLike {
  processMessage(userMessage: string): Promise<AgentResponse>;
  close(): Promise<void>;
}

export interface AgentLoopFactoryContext {
  sessionId: string;
  model?: string;
  traceId?: string;
  taskId: string;
  contextId: string;
}

export interface AgentLoopDeps {
  providers?: ProviderManager;
  memory?: MemoryPort;
  tools?: ToolRegistry;
  sendToAgent?: SendToAgentFn;
  cronTools?: CronToolPort;
  availablePeers?: string[];
  sandboxConfig?: SandboxConfig;
  traceWriter?: TraceWriter;
  traceId?: string;
  taskId?: string;
  contextId?: string;
  agentId?: string;
  workspaceDir?: string;
  workspaceKv?: Deno.Kv;
  runtimeCapabilities?: AgentRuntimeCapabilities;
  getRuntimeGrants?: () => AgentRuntimeGrant[];
}

export class AgentLoop implements AgentLoopLike {
  private config: AgentConfig;
  private providers: ProviderManager;
  private memory: MemoryPort;
  private context: ContextBuilder;
  private skills: SkillLoader;
  private tools: ToolRegistry;
  private maxIterations: number;
  private traceWriter: TraceWriter | null;
  private traceId: string | undefined;
  private taskId: string | undefined;
  private contextId: string | undefined;
  private agentId: string;
  private sessionId: string;
  private workspaceDir: string | undefined;
  private workspaceKv: Deno.Kv | undefined;
  private memoryFiles: string[] = [];
  private getRuntimeGrants?: () => AgentRuntimeGrant[];

  constructor(
    sessionId: string,
    config: AgentLoopConfig,
    agentConfig?: Partial<AgentConfig>,
    maxIterations = 10,
    deps?: AgentLoopDeps,
  ) {
    this.config = {
      model: config.agents?.defaults?.model || "anthropic/claude-sonnet-4-6",
      temperature: config.agents?.defaults?.temperature ?? 0.7,
      maxTokens: config.agents?.defaults?.maxTokens ?? 4096,
      systemPrompt: config.agents?.defaults?.systemPrompt,
      ...agentConfig,
    };

    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.memory = deps?.memory ?? new Memory(sessionId);
    this.tools = deps?.tools ?? new ToolRegistry();
    this.agentId = deps?.agentId ?? sessionId;
    this.sessionId = sessionId;
    this.workspaceDir = deps?.workspaceDir;
    this.workspaceKv = deps?.workspaceKv;
    this.context = new ContextBuilder(this.config, deps?.runtimeCapabilities);
    this.skills = this.createSkillsLoader(deps);
    this.maxIterations = maxIterations;
    this.traceWriter = deps?.traceWriter ?? null;
    this.traceId = deps?.traceId;
    this.taskId = deps?.taskId;
    this.contextId = deps?.contextId ?? deps?.taskId;
    this.getRuntimeGrants = deps?.getRuntimeGrants;

    if (!deps?.tools) this.registerBuiltInTools(config, deps);
    if (deps?.sendToAgent) {
      this.tools.register(
        new SendToAgentTool(deps.sendToAgent, deps.availablePeers),
      );
    }
    this.tools.register(new MemoryTool(this.memory));
    if (deps?.sandboxConfig) {
      const backend = createSandboxBackend(deps.sandboxConfig);
      const toolsCfg = {
        ...config.tools,
        workspaceDir: deps.workspaceDir,
        agentId: this.agentId,
      };
      this.tools.setBackend(
        backend,
        deps.sandboxConfig.execPolicy,
        toolsCfg,
        deps.sandboxConfig.networkAllow,
        deps.sandboxConfig.shell,
        deps.sandboxConfig,
        deps.runtimeCapabilities,
      );
    }
  }

  private registerBuiltInTools(
    config: AgentLoopConfig,
    deps?: AgentLoopDeps,
  ): void {
    const t = config.tools;
    this.tools.register(new ShellTool(t?.restrictToWorkspace));
    const wsCtx: WorkspaceContext | undefined = deps?.workspaceDir
      ? {
        workspaceDir: deps.workspaceDir,
        agentId: this.agentId,
        kv: deps.workspaceKv,
      }
      : undefined;
    this.tools.register(new ReadFileTool(wsCtx));
    this.tools.register(new WriteFileTool(wsCtx));
    this.tools.register(new WebFetchTool());
    this.tools.register(new CreateCronTool(deps?.cronTools));
    this.tools.register(new ListCronsTool(deps?.cronTools));
    this.tools.register(new DeleteCronTool(deps?.cronTools));
    this.tools.register(new EnableCronTool(deps?.cronTools));
    this.tools.register(new DisableCronTool(deps?.cronTools));
  }

  private createSkillsLoader(deps?: AgentLoopDeps): SkillLoader {
    if (isDeployEnvironment()) {
      if (deps?.workspaceKv) {
        return new KvSkillsLoader(deps.workspaceKv, this.agentId);
      }
      return new EmptySkillLoader(
        `Workspace KV is required to load skills in deploy mode for ${this.agentId}`,
      );
    }

    if (deps?.workspaceDir) {
      return new SkillsLoader(join(deps.workspaceDir, "skills"));
    }

    return new SkillsLoader();
  }

  private memoryTopics: string[] = [];

  private async refreshMemoryFiles(): Promise<string[]> {
    return await listAgentMemoryFiles({
      agentId: this.agentId,
      workspaceDir: this.workspaceDir,
      kv: this.workspaceKv,
      useWorkspaceKv: isDeployEnvironment(),
    });
  }

  async initialize(): Promise<void> {
    await this.memory.load();
    await this.skills.loadSkills();
    this.memoryTopics = await this.memory.listTopics();
    this.memoryFiles = await this.refreshMemoryFiles();
  }

  async processMessage(userMessage: string): Promise<AgentResponse> {
    await this.initialize();
    await this.memory.addMessage({ role: "user", content: userMessage });

    const CHARS_PER_TOKEN = 4;
    const CONTEXT_RATIO = 4;
    const maxChars =
      (this.config.maxTokens || 4096) * CHARS_PER_TOKEN * CONTEXT_RATIO;

    const { runner, kernelInput } = createLocalRunner({
      agentId: this.agentId,
      sessionId: this.sessionId,
      memoryTopics: this.memoryTopics,
      memoryFiles: this.memoryFiles,
      memory: this.memory,
      complete: (messages, model, temperature, maxTokens, tools) =>
        this.providers.complete(messages, model, temperature, maxTokens, tools),
      executeTool: (name, args) => this.tools.execute(name, args),
      observability: {
        traceWriter: this.traceWriter,
        traceId: this.traceId,
        agentId: this.agentId,
        sessionId: this.sessionId,
        correlationIds: {
          ...(this.taskId ? { taskId: this.taskId } : {}),
          ...(this.contextId ? { contextId: this.contextId } : {}),
        },
      },
      contextRefresh: {
        skills: this.skills,
        memory: this.memory,
        refreshMemoryFiles: () => this.refreshMemoryFiles(),
      },
      buildMessages: (memoryTopics, memoryFiles) => {
        const raw = this.context.buildContextMessages(
          this.memory.getMessages(),
          this.skills.getSkills(),
          this.tools.getDefinitions(),
          memoryTopics,
          memoryFiles,
          this.getRuntimeGrants?.() ?? [],
        );
        return this.context.truncateContext(raw, maxChars);
      },
      toolDefinitions: this.tools.getDefinitions(),
      llmConfig: this.config,
      maxIterations: this.maxIterations,
    });

    return await runner.run(kernelInput);
  }

  getMemory(): MemoryPort {
    return this.memory;
  }

  getTools(): ToolRegistry {
    return this.tools;
  }

  async close(): Promise<void> {
    await this.tools.close();
    this.memory.close();
  }
}
